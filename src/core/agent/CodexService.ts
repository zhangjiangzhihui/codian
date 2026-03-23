import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { Codex, type Thread, type ThreadEvent, type ThreadItem } from '../codex';

import type ClaudianPlugin from '../../main';
import { TOOL_BASH, TOOL_EDIT, TOOL_MCP, TOOL_TODO_WRITE, TOOL_WEB_SEARCH, TOOL_WRITE } from '../tools/toolNames';
import type {
  ChatMessage,
  Conversation,
  ExitPlanModeDecision,
  ImageAttachment,
  PermissionMode,
  SlashCommand,
  StreamChunk,
  UsageInfo,
} from '../types';
import { getContextWindowSize } from '../types';
import { stripCurrentNoteContext } from '../../utils/context';
import { getEnhancedPath, getMissingNodeError, parseEnvironmentVariables } from '../../utils/env';
import { getVaultPath } from '../../utils/path';
import { buildContextFromHistory, buildPromptWithHistoryContext } from '../../utils/session';
import type {
  AgentService,
  ApprovalCallback,
  AskUserQuestionCallback,
  EnsureReadyOptions,
  QueryOptions,
  RewindResult,
} from './AgentService';

type CodexThreadContext = {
  thread: Thread;
  threadId: string | null;
};

const CODEX_TEMP_DIR = 'claudian-codex-images';

export class CodexService implements AgentService {
  private plugin: ClaudianPlugin;
  private abortController: AbortController | null = null;
  private approvalCallback: ApprovalCallback | null = null;
  private approvalDismisser: (() => void) | null = null;
  private askUserQuestionCallback: AskUserQuestionCallback | null = null;
  private exitPlanModeCallback: ((input: Record<string, unknown>, signal?: AbortSignal) => Promise<ExitPlanModeDecision | null>) | null = null;
  private permissionModeSyncCallback: ((sdkMode: string) => void) | null = null;
  private readyStateListeners = new Set<(ready: boolean) => void>();
  private codex: Codex | null = null;
  private threadContext: CodexThreadContext | null = null;
  private threadConfigKey: string | null = null;
  private currentExternalContextPaths: string[] = [];
  private running = false;
  private itemTextSnapshots = new Map<string, string>();
  private lastAgentMessage = '';

  constructor(plugin: ClaudianPlugin, _mcpManager: unknown) {
    this.plugin = plugin;
  }

  onReadyStateChange(listener: (ready: boolean) => void): () => void {
    this.readyStateListeners.add(listener);
    try {
      listener(this.isReady());
    } catch {
      // ignore listener errors
    }
    return () => this.readyStateListeners.delete(listener);
  }

  async ensureReady(options?: EnsureReadyOptions): Promise<boolean> {
    if (options?.externalContextPaths !== undefined) {
      this.currentExternalContextPaths = options.externalContextPaths;
    }

    const nextThreadConfigKey = this.buildThreadConfigKey();
    const currentSessionId = options?.sessionId ?? this.getSessionId();
    const configChanged = this.threadContext !== null
      && this.threadConfigKey !== null
      && this.threadConfigKey !== nextThreadConfigKey;

    if (configChanged) {
      this.threadContext = null;
      this.threadConfigKey = null;
    } else if (options?.sessionId) {
      this.setSessionId(options.sessionId, this.currentExternalContextPaths);
    }

    if (!this.codex || options?.force) {
      this.codex = this.createCodexClient();
      if (this.threadContext?.threadId && !configChanged) {
        this.threadContext = this.createThreadContext(this.threadContext.threadId);
        this.threadConfigKey = nextThreadConfigKey;
      }
    }

    if (!this.threadContext) {
      this.threadContext = this.createThreadContext(configChanged ? null : currentSessionId);
      this.threadConfigKey = nextThreadConfigKey;
    }

    this.notifyReadyStateChange();
    return true;
  }

  async reloadMcpServers(): Promise<void> {
    // Codex SDK manages MCP through its own CLI config. Nothing to reload here.
  }

  applyForkState(conv: Pick<Conversation, 'sessionId' | 'sdkSessionId' | 'forkSource'>): string | null {
    return conv.sessionId ?? conv.sdkSessionId ?? conv.forkSource?.sessionId ?? null;
  }

  setPendingResumeAt(_uuid: string | undefined): void {
    // Codex threads don't support Claude-style resume points.
  }

  async *query(
    prompt: string,
    images?: ImageAttachment[],
    previousMessages?: Array<{ role: 'user' | 'assistant'; content: string }>,
    queryOptions?: QueryOptions,
  ): AsyncGenerator<StreamChunk> {
    const vaultPath = getVaultPath(this.plugin.app);
    if (!vaultPath) {
      yield { type: 'error', content: 'Could not determine vault path.' };
      return;
    }

    const resolvedCodexPath = this.plugin.getResolvedCodexCliPath();
    if (!resolvedCodexPath) {
      yield { type: 'error', content: 'Codex CLI not found. Install @openai/codex globally or set Codex CLI path in settings.' };
      return;
    }

    const enhancedPath = getEnhancedPath(this.plugin.getActiveEnvironmentVariables(), resolvedCodexPath);
    const missingNodeError = getMissingNodeError(resolvedCodexPath, enhancedPath);
    if (missingNodeError) {
      yield { type: 'error', content: missingNodeError.replace('Claude Code CLI', 'Codex CLI') };
      return;
    }

    await this.ensureReady({ externalContextPaths: queryOptions?.externalContextPaths });
    if (!this.threadContext) {
      yield { type: 'error', content: 'Failed to initialize Codex thread.' };
      return;
    }

    this.abortController = new AbortController();
    this.running = true;
    this.notifyReadyStateChange();

    const tempImagePaths: string[] = [];

    try {
      let turnPrompt = prompt;
      let turnImages = images;
      let turnHistory = previousMessages;

      if (!this.getSessionId() && previousMessages && previousMessages.length > 0) {
        turnPrompt = this.buildPromptWithRecoveredHistory(prompt, previousMessages as ChatMessage[]);
        turnHistory = undefined;
      }

      while (true) {
        this.lastAgentMessage = '';
        const input = await this.buildTurnInput(turnPrompt, turnImages, turnHistory, tempImagePaths);
        const result = await this.threadContext.thread.runStreamed(input, {
          signal: this.abortController.signal,
        });

        for await (const event of result.events) {
          const chunks = this.mapEventToChunks(event);
          for (const chunk of chunks) {
            yield chunk;
          }
        }

        const sessionId = this.threadContext.thread.id;
        if (sessionId) {
          this.threadContext.threadId = sessionId;
        }

        const nextAction = await this.handlePlanContinuation(this.lastAgentMessage);
        if (nextAction.type === 'done') {
          yield { type: 'done' };
          return;
        }

        if (nextAction.type === 'restart-current-thread') {
          this.threadContext = this.createThreadContext(this.threadContext.threadId);
          turnPrompt = nextAction.prompt;
          turnImages = undefined;
          turnHistory = undefined;
          continue;
        }
      }
    } catch (error) {
      if (this.abortController?.signal.aborted) {
        yield { type: 'error', content: 'Cancelled' };
      } else {
        const message = error instanceof Error ? error.message : 'Unknown Codex error';
        yield { type: 'error', content: message };
      }
    } finally {
      this.running = false;
      this.abortController = null;
      this.itemTextSnapshots.clear();
      this.lastAgentMessage = '';
      this.notifyReadyStateChange();
      await Promise.all(tempImagePaths.map(async (filePath) => {
        try {
          await fs.unlink(filePath);
        } catch {
          // ignore cleanup errors
        }
      }));
    }
  }

  cancel(): void {
    this.abortController?.abort();
  }

  resetSession(): void {
    this.threadContext = this.createThreadContext(null);
    this.threadConfigKey = this.buildThreadConfigKey();
    this.notifyReadyStateChange();
  }

  getSessionId(): string | null {
    return this.threadContext?.thread.id ?? this.threadContext?.threadId ?? null;
  }

  isReady(): boolean {
    return this.codex !== null && this.threadContext !== null && !this.running;
  }

  async getSupportedCommands(): Promise<SlashCommand[]> {
    return [];
  }

  setSessionId(id: string | null, externalContextPaths?: string[]): void {
    if (externalContextPaths !== undefined) {
      this.currentExternalContextPaths = externalContextPaths;
    }
    if (!this.codex) {
      this.codex = this.createCodexClient();
    }
    this.threadContext = this.createThreadContext(id);
    this.threadConfigKey = this.buildThreadConfigKey();
    this.notifyReadyStateChange();
  }

  closePersistentQuery(_reason?: string): void {
    this.cancel();
    this.running = false;
    this.notifyReadyStateChange();
  }

  consumeSessionInvalidation(): boolean {
    return false;
  }

  async rewind(_sdkUserUuid: string, _sdkAssistantUuid: string): Promise<RewindResult> {
    return {
      canRewind: false,
      error: 'Rewind is not supported by the Codex provider yet.',
      filesChanged: [],
    };
  }

  cleanup(): void {
    this.closePersistentQuery('cleanup');
    this.resetSession();
  }

  setApprovalCallback(callback: ApprovalCallback | null): void {
    this.approvalCallback = callback;
  }

  setApprovalDismisser(dismisser: (() => void) | null): void {
    this.approvalDismisser = dismisser;
  }

  setAskUserQuestionCallback(callback: AskUserQuestionCallback | null): void {
    this.askUserQuestionCallback = callback;
  }

  setExitPlanModeCallback(
    callback: ((input: Record<string, unknown>, signal?: AbortSignal) => Promise<ExitPlanModeDecision | null>) | null
  ): void {
    this.exitPlanModeCallback = callback;
  }

  setPermissionModeSyncCallback(callback: ((sdkMode: string) => void) | null): void {
    this.permissionModeSyncCallback = callback;
  }

  private notifyReadyStateChange(): void {
    const ready = this.isReady();
    for (const listener of this.readyStateListeners) {
      try {
        listener(ready);
      } catch {
        // ignore listener errors
      }
    }
  }

  private createCodexClient(): Codex {
    const envVars = parseEnvironmentVariables(this.plugin.getActiveEnvironmentVariables());
    const apiKey = envVars.CODEX_API_KEY || envVars.OPENAI_API_KEY;
    const baseUrl = envVars.OPENAI_BASE_URL;
    const codexPath = this.plugin.getResolvedCodexCliPath() || this.plugin.settings.codexCliPath || 'codex';
    const enhancedPath = getEnhancedPath(this.plugin.getActiveEnvironmentVariables(), codexPath);

    return new Codex({
      apiKey: apiKey || undefined,
      baseUrl: baseUrl || undefined,
      codexPathOverride: codexPath,
      env: {
        ...process.env,
        ...envVars,
        PATH: enhancedPath,
      } as Record<string, string>,
    });
  }

  private createThreadContext(threadId: string | null): CodexThreadContext {
    const threadOptions = this.buildThreadOptions();
    const codex = this.codex ?? this.createCodexClient();
    this.codex = codex;
    return {
      thread: threadId ? codex.resumeThread(threadId, threadOptions) : codex.startThread(threadOptions),
      threadId,
    };
  }

  private buildThreadOptions() {
    const permissionMode = this.plugin.settings.permissionMode;
    const sandboxMode = this.mapSandboxMode(permissionMode);

    return {
      model: this.plugin.settings.model,
      sandboxMode: permissionMode === 'yolo' ? undefined : sandboxMode,
      workingDirectory: getVaultPath(this.plugin.app) || undefined,
      skipGitRepoCheck: true,
      additionalDirectories: this.currentExternalContextPaths.length > 0 ? this.currentExternalContextPaths : undefined,
      modelReasoningEffort: this.mapReasoningEffort(this.plugin.settings.effortLevel),
      approvalPolicy: permissionMode === 'yolo' ? undefined : 'never' as const,
      dangerouslyBypassApprovalsAndSandbox: permissionMode === 'yolo',
      webSearchEnabled: false,
      networkAccessEnabled: permissionMode === 'yolo',
    };
  }

  private mapSandboxMode(permissionMode: PermissionMode): 'read-only' | 'workspace-write' | 'danger-full-access' {
    if (permissionMode === 'yolo') return 'danger-full-access';
    return 'read-only';
  }

  private mapReasoningEffort(effort: string): 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' {
    if (effort === 'max') return 'xhigh';
    if (effort === 'high' || effort === 'medium' || effort === 'low') return effort;
    return 'medium';
  }

  private buildThreadConfigKey(): string {
    const vaultPath = getVaultPath(this.plugin.app) || '';
    const additionalDirectories = [...this.currentExternalContextPaths].sort();

    return JSON.stringify({
      model: this.plugin.settings.model,
      permissionMode: this.plugin.settings.permissionMode,
      effortLevel: this.plugin.settings.effortLevel,
      vaultPath,
      additionalDirectories,
    });
  }

  private async buildTurnInput(
    prompt: string,
    images: ImageAttachment[] | undefined,
    previousMessages: Array<{ role: 'user' | 'assistant'; content: string }> | undefined,
    tempImagePaths: string[],
  ): Promise<Array<{ type: 'text'; text: string } | { type: 'local_image'; path: string }>> {
    const items: Array<{ type: 'text'; text: string } | { type: 'local_image'; path: string }> = [];
    const historyPrompt = this.buildHistoryPrompt(previousMessages);
    const systemPrompt = this.buildSystemPrompt();

    const combinedPrompt = [systemPrompt, historyPrompt, prompt].filter(Boolean).join('\n\n');
    items.push({ type: 'text', text: combinedPrompt });

    if (images && images.length > 0) {
      for (const image of images) {
        const tempPath = await this.writeTempImage(image);
        tempImagePaths.push(tempPath);
        items.push({ type: 'local_image', path: tempPath });
      }
    }

    return items;
  }

  private buildHistoryPrompt(previousMessages?: Array<{ role: 'user' | 'assistant'; content: string }>): string {
    if (!previousMessages || previousMessages.length === 0 || this.getSessionId()) {
      return '';
    }

    const transcript = previousMessages
      .filter((message) => message.content.trim().length > 0)
      .map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}:\n${message.content}`)
      .join('\n\n');

    if (!transcript) {
      return '';
    }

    return `Conversation transcript for continuity:\n\n${transcript}`;
  }

  private buildPromptWithRecoveredHistory(
    prompt: string,
    previousMessages: ChatMessage[],
  ): string {
    const historyContext = buildContextFromHistory(previousMessages);
    if (!historyContext) {
      return prompt;
    }

    const actualPrompt = stripCurrentNoteContext(prompt);
    return buildPromptWithHistoryContext(historyContext, prompt, actualPrompt, previousMessages);
  }

  private buildSystemPrompt(): string {
    const providerName = this.plugin.settings.agentProvider === 'codex' ? 'Codex' : 'Claude';
    const backendName = this.plugin.settings.agentProvider === 'codex' ? 'OpenAI Codex' : 'Claude Code';
    const userName = this.plugin.settings.userName?.trim();
    const parts = [
      `You are ${providerName}, the ${backendName}-backed agent running inside an Obsidian plugin.`,
      'You are not just a coding executor. You are also an Obsidian knowledge-work assistant who helps with notes, Markdown, vault organization, writing, code, files, project structure, and repository work.',
      'Operate as a polished in-product assistant: clear, capable, practical, and slightly proactive when that helps the user.',
      'Use the current vault as your working directory and prefer vault-relative file paths when you mention files.',
      'Write answers that render cleanly in Obsidian Markdown. Use headings, bullets, tables, and fenced code when they improve readability. Do not default to one-line answers unless the user asked a very narrow factual question.',
      'Match the user\'s language and tone. If the user writes in Chinese, answer in Chinese unless they ask otherwise.',
      'Do not claim to be "Claudian". Do not pretend to be Claude when the active provider is Codex.',
      'If the user asks who you are, what model you are, what you can do, or asks for a self-introduction, answer with a short but substantive introduction. Include: identity, your role inside Obsidian, your main capabilities, and how you can help next.',
      'For self-introduction style answers, prefer a structured format with a short intro sentence followed by 3-5 concise capability bullets or sections.',
      'Emphasize Obsidian-native strengths when relevant: Markdown, wiki-links, frontmatter, vault navigation, note creation/editing, code work, and workflow support.',
      'Be accurate about permissions. If the current mode is read-only, say so clearly instead of implying you can edit files.',
      userName ? `The user\'s preferred name is ${userName}. Use it naturally when helpful, but do not overdo it.` : '',
      'When you create or edit files, operate directly on the vault files rather than only suggesting text, unless the current mode forbids edits.',
      this.plugin.settings.systemPrompt.trim(),
    ];

    if (this.plugin.settings.permissionMode === 'plan') {
      parts.push('Plan mode is active. Do not make changes, do not execute mutating commands, and do not edit files.');
      parts.push('Respond with a concise plan only, then wait for explicit user approval before any implementation work.');
      this.permissionModeSyncCallback?.('plan');
    } else if (this.plugin.settings.permissionMode === 'normal') {
      parts.push('Safe mode is active. The environment is read-only.');
      parts.push('You may inspect files and reason about the task, but do not attempt to modify files or run mutating commands.');
      parts.push('If implementation is required, explain what needs to be changed and ask the user to switch to YOLO mode.');
      this.permissionModeSyncCallback?.('default');
    } else if (this.plugin.settings.permissionMode === 'yolo') {
      parts.push('YOLO mode is active. You may make changes directly when needed.');
      parts.push('When the user explicitly asks to create or update a note or code file, perform the change directly in the vault and then summarize what changed.');
      this.permissionModeSyncCallback?.('bypassPermissions');
    }

    return parts.filter(Boolean).join('\n\n');
  }

  private async handlePlanContinuation(planContent: string): Promise<
    { type: 'done' } |
    { type: 'restart-current-thread'; prompt: string }
  > {
    if (this.plugin.settings.permissionMode !== 'plan' || !this.exitPlanModeCallback) {
      return { type: 'done' };
    }

    const decision = await this.exitPlanModeCallback(
      { planContent },
      this.abortController?.signal
    );

    if (!decision) {
      return { type: 'done' };
    }

    if (decision.type === 'feedback') {
      return {
        type: 'restart-current-thread',
        prompt: [
          'The user reviewed your plan and requested changes.',
          'Revise the plan only. Do not implement anything yet.',
          `User feedback:\n${decision.text}`,
        ].join('\n\n'),
      };
    }

    if (decision.type === 'approve') {
      return {
        type: 'restart-current-thread',
        prompt: [
          'The user approved the plan.',
          'Implement it now in the current session.',
          planContent ? `Approved plan:\n${planContent}` : '',
        ].filter(Boolean).join('\n\n'),
      };
    }

    return { type: 'done' };
  }

  private async writeTempImage(image: ImageAttachment): Promise<string> {
    const dir = path.join(os.tmpdir(), CODEX_TEMP_DIR);
    await fs.mkdir(dir, { recursive: true });

    const ext = this.getImageExtension(image.mediaType);
    const filePath = path.join(dir, `${image.id || randomUUID()}.${ext}`);
    await fs.writeFile(filePath, Buffer.from(image.data, 'base64'));
    return filePath;
  }

  private getImageExtension(mediaType: string): string {
    switch (mediaType) {
      case 'image/jpeg':
        return 'jpg';
      case 'image/png':
        return 'png';
      case 'image/gif':
        return 'gif';
      case 'image/webp':
        return 'webp';
      default:
        return 'png';
    }
  }

  private mapEventToChunks(event: ThreadEvent): StreamChunk[] {
    switch (event.type) {
      case 'thread.started':
        if (this.threadContext) {
          this.threadContext.threadId = event.thread_id;
        }
        return [{ type: 'sdk_user_sent', uuid: event.thread_id }];
      case 'turn.completed':
        return event.usage ? [{ type: 'usage', usage: this.mapUsage(event.usage), sessionId: this.getSessionId() }] : [];
      case 'turn.failed':
        return [{ type: 'error', content: event.error.message }];
      case 'error':
        return [{ type: 'error', content: event.message }];
      case 'item.started':
      case 'item.updated':
      case 'item.completed':
        return this.mapItemEvent(event.item, event.type === 'item.completed');
      default:
        return [];
    }
  }

  private mapItemEvent(item: ThreadItem, completed: boolean): StreamChunk[] {
    switch (item.type) {
      case 'agent_message':
        if (item.text.trim()) {
          this.lastAgentMessage = item.text;
        }
        return this.emitTextDelta(item.id, item.text, 'text');
      case 'reasoning':
        return this.emitTextDelta(item.id, item.text, 'thinking');
      case 'command_execution':
        return completed
          ? [
            { type: 'tool_use', id: item.id, name: TOOL_BASH, input: { command: item.command } },
            {
              type: 'tool_result',
              id: item.id,
              content: item.aggregated_output || (item.exit_code === 0 ? 'Command completed.' : 'Command failed.'),
              isError: item.status === 'failed',
            },
          ]
          : [{ type: 'tool_use', id: item.id, name: TOOL_BASH, input: { command: item.command } }];
      case 'file_change':
        return [
          {
            type: 'tool_use',
            id: item.id,
            name: item.changes.some((change) => change.kind === 'update' || change.kind === 'delete') ? TOOL_EDIT : TOOL_WRITE,
            input: {
              file_path: item.changes.length === 1 ? (item.changes[0]?.path || 'file') : `${item.changes.length} files`,
              codexChanges: item.changes.map((change) => `${change.kind}:${change.path}`),
              codexChangeCount: item.changes.length,
            },
          },
          {
            type: 'tool_result',
            id: item.id,
            content: item.changes.map((change) => `${change.kind}: ${change.path}`).join('\n') || 'No file details.',
            isError: item.status === 'failed',
          },
        ];
      case 'mcp_tool_call':
        return completed
          ? [
            {
              type: 'tool_use',
              id: item.id,
              name: TOOL_MCP,
              input: { server: item.server, tool: item.tool, arguments: item.arguments as Record<string, unknown> },
            },
            {
              type: 'tool_result',
              id: item.id,
              content: item.error?.message || this.stringifyMcpResult(item.result),
              isError: item.status === 'failed',
            },
          ]
          : [
            {
              type: 'tool_use',
              id: item.id,
              name: TOOL_MCP,
              input: { server: item.server, tool: item.tool, arguments: item.arguments as Record<string, unknown> },
            },
          ];
      case 'web_search':
        return [{ type: 'tool_use', id: item.id, name: TOOL_WEB_SEARCH, input: { query: item.query } }];
      case 'todo_list':
        return [
          {
            type: 'tool_use',
            id: item.id,
            name: TOOL_TODO_WRITE,
            input: {
              todos: item.items.map((todo) => ({
                content: todo.text,
                status: todo.completed ? 'completed' : 'in_progress',
              })),
            },
          },
          {
            type: 'tool_result',
            id: item.id,
            content: item.items.map((todo) => `${todo.completed ? '[x]' : '[ ]'} ${todo.text}`).join('\n'),
          },
        ];
      case 'error':
        return [{ type: 'error', content: item.message }];
      default:
        return [];
    }
  }

  private emitTextDelta(id: string, nextText: string, type: 'text' | 'thinking'): StreamChunk[] {
    if (!nextText) return [];
    const previousText = this.itemTextSnapshots.get(id) || '';
    const delta = nextText.startsWith(previousText)
      ? nextText.slice(previousText.length)
      : nextText;
    this.itemTextSnapshots.set(id, nextText);
    if (!delta) return [];
    return [{ type, content: delta }];
  }

  private stringifyMcpResult(result: unknown): string {
    if (!result || typeof result !== 'object') return 'MCP tool completed.';
    const normalized = result as {
      content?: Array<{ type?: string; text?: string }>;
      structured_content?: unknown;
    };
    const textParts = (normalized.content || [])
      .map((block) => typeof block.text === 'string' ? block.text : '')
      .filter(Boolean);
    if (textParts.length > 0) {
      return textParts.join('\n');
    }
    if (normalized.structured_content !== undefined) {
      try {
        return JSON.stringify(normalized.structured_content, null, 2);
      } catch {
        return 'MCP tool completed.';
      }
    }
    return 'MCP tool completed.';
  }

  private mapUsage(usage: { input_tokens: number; cached_input_tokens: number; output_tokens: number }): UsageInfo {
    const model = this.plugin.settings.model;
    const contextWindow = getContextWindowSize(model, this.plugin.settings.customContextLimits);
    const contextTokens = usage.input_tokens + usage.cached_input_tokens + usage.output_tokens;
    const percentage = Math.min(100, Math.max(0, Math.round((contextTokens / contextWindow) * 100)));
    return {
      model,
      inputTokens: usage.input_tokens,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: usage.cached_input_tokens,
      contextWindow,
      contextTokens,
      percentage,
    };
  }
}
