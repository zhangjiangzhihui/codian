import { createAgentService } from '../../core/agent';
import type { ImageAttachment, StreamChunk } from '../../core/types';
import type { TabData } from '../../features/chat/tabs/types';
import type ClaudianPlugin from '../../main';

type ActiveExecution = {
  service: ReturnType<typeof createAgentService>;
  cancel: () => void;
};

export interface RemoteExecutionResult {
  conversationId: string;
  replyText: string;
}

export class RemoteExecutionService {
  private activeExecutions = new Map<string, ActiveExecution>();

  constructor(private plugin: ClaudianPlugin) {}

  async execute(
    chatKey: string,
    prompt: string,
    conversationId?: string,
    images?: ImageAttachment[],
  ): Promise<RemoteExecutionResult> {
    const openTab = await this.resolveTargetTab(conversationId);
    if (openTab) {
      const tabResult = await this.executeViaOpenTab(openTab, prompt, images);
      this.plugin.settings.telegram.chatConversationMap[chatKey] = tabResult.conversationId;
      await this.plugin.saveSettings();
      return tabResult;
    }

    const conversation = await this.ensureConversation(chatKey, conversationId);
    const service = createAgentService(this.plugin, this.plugin.mcpManager);
    const externalContextPaths = conversation.messages.length > 0
      ? conversation.externalContextPaths || []
      : this.plugin.settings.persistentExternalContextPaths || [];
    const previousMessages = conversation.messages.map((message) => ({
      role: message.role,
      content: message.content,
    }));

    this.activeExecutions.set(chatKey, {
      service,
      cancel: () => service.cancel(),
    });

    try {
      await service.ensureReady({
        sessionId: service.applyForkState(conversation) ?? undefined,
        externalContextPaths,
      });

      const chunks: StreamChunk[] = [];
      for await (const chunk of service.query(prompt, images, previousMessages, { externalContextPaths })) {
        chunks.push(chunk);
      }

      const replyText = this.buildReplyText(chunks);
      const nextSessionId = service.getSessionId();
      await this.plugin.updateConversation(conversation.id, {
        sessionId: nextSessionId,
        sdkSessionId: nextSessionId ?? undefined,
        lastResponseAt: Date.now(),
      });

      return {
        conversationId: conversation.id,
        replyText,
      };
    } finally {
      this.activeExecutions.delete(chatKey);
      service.cleanup();
    }
  }

  cancel(chatKey: string): boolean {
    const active = this.activeExecutions.get(chatKey);
    if (!active) return false;
    active.cancel();
    return true;
  }

  cleanup(): void {
    for (const active of this.activeExecutions.values()) {
      active.cancel();
      active.service.cleanup();
    }
    this.activeExecutions.clear();
  }

  private async ensureConversation(chatKey: string, conversationId?: string) {
    const existingId = conversationId ?? this.plugin.settings.telegram.chatConversationMap[chatKey];
    const existing = existingId ? await this.plugin.getConversationById(existingId) : null;
    if (existing) {
      return existing;
    }

    const created = await this.plugin.createConversation();
    this.plugin.settings.telegram.chatConversationMap[chatKey] = created.id;
    await this.plugin.saveSettings();
    return created;
  }

  private async resolveTargetTab(conversationId?: string): Promise<TabData | null> {
    if (conversationId) {
      const located = this.plugin.findConversationAcrossViews(conversationId);
      if (located) {
        const tab = located.view.getTabManager()?.getAllTabs().find((item) => item.id === located.tabId) ?? null;
        if (tab) {
          return tab;
        }
      }
    }

    return this.plugin.getView()?.getActiveTab() ?? null;
  }

  private async executeViaOpenTab(tab: TabData, prompt: string, images?: ImageAttachment[]): Promise<RemoteExecutionResult> {
    const inputController = tab.controllers.inputController;
    if (!inputController) {
      throw new Error('Active Codian tab is missing its input controller.');
    }

    const baselineLength = tab.state.messages.length;
    const baselineConversationId = tab.state.currentConversationId;
    const startedAt = Date.now();

    await inputController.sendMessage({ content: prompt, imagesOverride: images });
    const message = await this.waitForAssistantMessage(tab, baselineLength, baselineConversationId, startedAt);
    const nextConversationId = tab.state.currentConversationId;

    if (!nextConversationId) {
      throw new Error('The visible Codian tab did not create or bind a conversation.');
    }

    return {
      conversationId: nextConversationId,
      replyText: message?.content?.trim() || 'Execution completed, but no text response was returned.',
    };
  }

  private async waitForAssistantMessage(
    tab: TabData,
    baselineLength: number,
    baselineConversationId: string | null,
    startedAt: number,
  ) {
    const timeoutAt = Date.now() + 10 * 60 * 1000;

    while (Date.now() < timeoutAt) {
      const conversationChanged = tab.state.currentConversationId !== baselineConversationId;
      const newMessages = tab.state.messages.slice(baselineLength);
      const assistant = [...newMessages]
        .reverse()
        .find((message) => message.role === 'assistant' && message.timestamp >= startedAt);

      if (assistant && !tab.state.isStreaming && !tab.state.queuedMessage) {
        return assistant;
      }

      if (conversationChanged && assistant && !tab.state.isStreaming) {
        return assistant;
      }

      await new Promise((resolve) => window.setTimeout(resolve, 200));
    }

    throw new Error('Timed out waiting for the visible Codian tab to finish the Telegram-triggered request.');
  }

  private buildReplyText(chunks: StreamChunk[]): string {
    let text = '';
    let lastToolResult = '';
    let error = '';

    for (const chunk of chunks) {
      if (chunk.type === 'text') {
        text += chunk.content;
      } else if (chunk.type === 'tool_result' && chunk.content.trim()) {
        lastToolResult = chunk.content.trim();
      } else if (chunk.type === 'error' || chunk.type === 'blocked') {
        error = chunk.content.trim();
      }
    }

    if (error) {
      return `Execution failed:\n${error}`;
    }

    const normalized = text.trim();
    if (normalized) {
      return normalized;
    }

    if (lastToolResult) {
      return lastToolResult;
    }

    return 'Execution completed, but no text response was returned.';
  }
}
