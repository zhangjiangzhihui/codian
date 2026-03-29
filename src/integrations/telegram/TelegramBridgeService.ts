import { requestUrl } from 'obsidian';

import type ClaudianPlugin from '../../main';
import type { ImageAttachment, ImageMediaType } from '../../core/types';
import { RemoteExecutionService } from './RemoteExecutionService';
import type { TelegramDocument, TelegramFileInfo, TelegramMessage, TelegramSendMessageResponse, TelegramUpdate } from './types';

const TELEGRAM_API_BASE = 'https://api.telegram.org';
const RETRY_DELAY_MS = 3000;
const TELEGRAM_REQUEST_TIMEOUT_MS = 10000;
const TELEGRAM_EXECUTION_TIMEOUT_MS = 120000;

export class TelegramBridgeService {
  private remoteExecution: RemoteExecutionService;
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private abortController: AbortController | null = null;
  private activeChats = new Set<string>();
  private activeChatStartedAt = new Map<string, number>();
  private configKey = '';
  private lastError: string | null = null;
  private lastSuccessAt: number | null = null;
  private lastUpdateReceivedAt: number | null = null;
  private lastMessageHandledAt: number | null = null;
  private lastSkipReason: string | null = null;

  constructor(private plugin: ClaudianPlugin) {
    this.remoteExecution = new RemoteExecutionService(plugin);
  }

  async sync(): Promise<void> {
    const nextKey = this.getConfigKey();
    const shouldRun = this.shouldRun();

    if (!shouldRun) {
      await this.stop();
      this.configKey = nextKey;
      this.lastError = null;
      return;
    }

    if (this.running && this.configKey === nextKey) {
      return;
    }

    await this.stop();
    this.configKey = nextKey;
    this.start();
  }

  async reset(): Promise<void> {
    await this.stop();
    this.lastError = null;
    this.lastSuccessAt = null;
    this.lastUpdateReceivedAt = null;
    this.lastMessageHandledAt = null;
    this.lastSkipReason = null;
    this.configKey = '';
    this.plugin.settings.telegram.lastUpdateId = 0;
    await this.plugin.saveSettings();
    await this.sync();
  }

  start(): void {
    if (this.running || !this.shouldRun()) return;
    this.running = true;
    this.lastError = null;
    this.abortController = new AbortController();
    this.loopPromise = this.pollLoop(this.abortController.signal).finally(() => {
      this.running = false;
      this.loopPromise = null;
      this.abortController = null;
    });
  }

  async stop(): Promise<void> {
    this.abortController?.abort();
    this.remoteExecution.cleanup();
    this.activeChats.clear();
    this.activeChatStartedAt.clear();
    try {
      await this.loopPromise;
    } catch {
      // Ignore stop-time errors.
    }
  }

  private shouldRun(): boolean {
    const { telegram } = this.plugin.settings;
    return telegram.enabled && telegram.botToken.trim().length > 0;
  }

  private getConfigKey(): string {
    const { telegram } = this.plugin.settings;
    return JSON.stringify({
      enabled: telegram.enabled,
      token: telegram.botToken.trim(),
      users: [...telegram.allowedUserIds].sort(),
      chats: [...telegram.allowedChatIds].sort(),
      allowGroupChats: telegram.allowGroupChats,
      timeout: telegram.pollTimeoutSeconds,
    });
  }

  private async pollLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted && this.shouldRun()) {
      try {
        const updates = await this.fetchUpdates(signal);
        const batches = this.collectMessageBatches(updates);
        for (const batch of batches) {
          if (signal.aborted) return;
          this.lastUpdateReceivedAt = Date.now();
          await this.handleMessageBatch(batch);
          this.plugin.settings.telegram.lastUpdateId = Math.max(this.plugin.settings.telegram.lastUpdateId, batch.lastUpdateId);
        }
        if (updates.length > 0) {
          await this.plugin.saveSettings();
        }
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        this.lastError = error instanceof Error ? error.message : String(error);
        console.error('[Codian][Telegram] Polling failed', error);
        await this.delay(RETRY_DELAY_MS, signal);
      }
    }
  }

  async testConnection(): Promise<string> {
    const token = this.plugin.settings.telegram.botToken.trim();
    if (!token) {
      this.lastError = 'Telegram bot token is empty.';
      return this.lastError;
    }

    try {
      const response = await this.fetchWithTimeout(this.buildApiUrl('getMe'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!response.ok) {
        throw new Error(`Telegram getMe failed: HTTP ${response.status}`);
      }

      const payload = await response.json() as {
        ok: boolean;
        result?: { username?: string; first_name?: string };
        description?: string;
      };

      if (!payload.ok) {
        throw new Error(payload.description || 'Telegram getMe failed');
      }

      this.lastError = null;
      this.lastSuccessAt = Date.now();
      const botName = payload.result?.username || payload.result?.first_name || 'unknown bot';
      return `Connected successfully as ${botName}.`;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      return this.lastError;
    }
  }

  getStatusSummary(): string {
    const token = this.plugin.settings.telegram.botToken.trim();
    if (!this.plugin.settings.telegram.enabled) {
      return 'Disabled';
    }
    if (!token) {
      return 'Enabled, but bot token is missing';
    }
    if (this.lastError) {
      return `Connection issue: ${this.lastError}`;
    }
    const statusBits: string[] = [];
    if (this.lastSuccessAt) {
      statusBits.push(`API ok: ${new Date(this.lastSuccessAt).toLocaleString()}`);
    }
    if (this.lastUpdateReceivedAt) {
      statusBits.push(`last update: ${new Date(this.lastUpdateReceivedAt).toLocaleString()}`);
    }
    if (this.lastMessageHandledAt) {
      statusBits.push(`last handled: ${new Date(this.lastMessageHandledAt).toLocaleString()}`);
    }
    if (this.lastSkipReason) {
      statusBits.push(`last skip: ${this.lastSkipReason}`);
    }
    if (this.running) {
      statusBits.unshift('Running');
    } else {
      statusBits.unshift('Enabled');
    }
    return statusBits.length > 0 ? statusBits.join(' | ') : 'Enabled, waiting to start.';
  }

  private async fetchUpdates(signal: AbortSignal): Promise<TelegramUpdate[]> {
    const { telegram } = this.plugin.settings;
    const url = this.buildApiUrl('getUpdates');
    const response = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        offset: telegram.lastUpdateId > 0 ? telegram.lastUpdateId + 1 : undefined,
        timeout: telegram.pollTimeoutSeconds,
        allowed_updates: ['message'],
      }),
      signal,
    });

    if (!response.ok) {
      throw new Error(`Telegram getUpdates failed: HTTP ${response.status}`);
    }

    const payload = await response.json() as { ok: boolean; result?: TelegramUpdate[]; description?: string };
    if (!payload.ok) {
      if (payload.description?.includes('webhook')) {
        throw new Error('Telegram bot still has an active webhook. Delete the webhook first, then retry long polling.');
      }
      throw new Error(payload.description || 'Telegram getUpdates failed');
    }

    this.lastError = null;
    this.lastSuccessAt = Date.now();
    return payload.result || [];
  }

  private collectMessageBatches(updates: TelegramUpdate[]): Array<{ messages: TelegramMessage[]; lastUpdateId: number }> {
    const batches: Array<{ messages: TelegramMessage[]; lastUpdateId: number }> = [];
    const mediaGroupMap = new Map<string, { messages: TelegramMessage[]; lastUpdateId: number }>();

    for (const update of updates) {
      const message = update.message;
      if (!message) {
        batches.push({ messages: [], lastUpdateId: update.update_id });
        continue;
      }

      const mediaGroupId = message.media_group_id;
      if (!mediaGroupId) {
        batches.push({ messages: [message], lastUpdateId: update.update_id });
        continue;
      }

      const batchKey = `${message.chat.id}:${mediaGroupId}`;
      const existing = mediaGroupMap.get(batchKey);
      if (existing) {
        existing.messages.push(message);
        existing.lastUpdateId = Math.max(existing.lastUpdateId, update.update_id);
        continue;
      }

      const created = { messages: [message], lastUpdateId: update.update_id };
      mediaGroupMap.set(batchKey, created);
      batches.push(created);
    }

    return batches;
  }

  private async handleMessageBatch(batch: { messages: TelegramMessage[]; lastUpdateId: number }): Promise<void> {
    const [message] = batch.messages;
    if (!message) {
      this.lastSkipReason = 'update has no message payload';
      return;
    }

    if (batch.messages.some((entry) => !this.isAuthorized(entry))) {
      this.lastSkipReason = `message blocked by allowlist: chat=${message.chat.id} user=${message.from?.id ?? 'unknown'}`;
      await this.safeReply(message.chat.id, 'Unauthorized Telegram chat or user.');
      return;
    }

    const chatKey = String(message.chat.id);
    const textContent = this.extractBatchText(batch.messages);
    const unsupportedHints = this.collectUnsupportedMediaHints(batch.messages);

    if (textContent === '/start' || textContent === '/help') {
      await this.safeReply(message.chat.id, 'Send a message to execute it in Codian. Use /new to start a fresh conversation or /stop to cancel the current run.');
      this.lastSkipReason = null;
      return;
    }

    if (textContent === '/new') {
      delete this.plugin.settings.telegram.chatConversationMap[chatKey];
      await this.plugin.saveSettings();
      await this.safeReply(message.chat.id, 'A new Codian conversation will be used for your next message.');
      this.lastSkipReason = null;
      return;
    }

    if (textContent === '/stop') {
      const cancelled = this.remoteExecution.cancel(chatKey);
      await this.safeReply(message.chat.id, cancelled ? 'Current execution cancelled.' : 'No active execution for this chat.');
      this.lastSkipReason = null;
      return;
    }

    if (this.activeChats.has(chatKey)) {
      const startedAt = this.activeChatStartedAt.get(chatKey) ?? Date.now();
      if (Date.now() - startedAt > TELEGRAM_EXECUTION_TIMEOUT_MS) {
        this.remoteExecution.cancel(chatKey);
        this.activeChats.delete(chatKey);
        this.activeChatStartedAt.delete(chatKey);
      } else {
      this.lastSkipReason = 'chat is busy with a previous request';
      await this.safeReply(message.chat.id, 'A previous request is still running for this chat. Wait for it to finish or send /stop.');
      return;
      }
    }

    this.activeChats.add(chatKey);
    this.activeChatStartedAt.set(chatKey, Date.now());
    try {
      const images = await this.extractTelegramImagesFromBatch(batch.messages);
      const promptText = this.buildExecutionPrompt(textContent, images.length, batch.messages, unsupportedHints);
      if (!promptText && images.length === 0) {
        this.lastSkipReason = 'message batch has no text, caption, supported image, or fallback media note';
        return;
      }

      this.lastMessageHandledAt = Date.now();
      this.lastSkipReason = null;
      await this.safeReply(message.chat.id, 'Request received. Running in Codian now.');
      const conversationId = this.plugin.settings.telegram.chatConversationMap[chatKey];
      const result = await this.runExecutionWithTimeout(
        chatKey,
        this.remoteExecution.execute(chatKey, promptText, conversationId, images, promptText),
      );
      this.plugin.settings.telegram.chatConversationMap[chatKey] = result.conversationId;
      await this.plugin.saveSettings();
      await this.safeReply(message.chat.id, result.replyText);
    } catch (error) {
      const description = error instanceof Error ? error.message : String(error);
      await this.safeReply(message.chat.id, `Execution failed:\n${description}`);
    } finally {
      this.activeChats.delete(chatKey);
      this.activeChatStartedAt.delete(chatKey);
    }
  }

  private isAuthorized(message: TelegramMessage): boolean {
    const { telegram } = this.plugin.settings;
    const chatId = String(message.chat.id);
    const userId = message.from ? String(message.from.id) : '';
    const isPrivate = message.chat.type === 'private';

    if (!isPrivate && !telegram.allowGroupChats) {
      return false;
    }

    if (telegram.allowedChatIds.length > 0 && !telegram.allowedChatIds.includes(chatId)) {
      return false;
    }

    if (telegram.allowedUserIds.length > 0 && (!userId || !telegram.allowedUserIds.includes(userId))) {
      return false;
    }

    return true;
  }

  private async safeReply(chatId: number, text: string): Promise<void> {
    try {
      for (const chunk of this.splitTelegramMessage(text)) {
        await this.sendMessage(chatId, chunk);
      }
    } catch (error) {
      console.error('[Codian][Telegram] sendMessage failed', error);
    }
  }

  private async sendMessage(chatId: number, text: string): Promise<TelegramSendMessageResponse> {
    const response = await this.fetchWithTimeout(this.buildApiUrl('sendMessage'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
      }),
    });

    if (!response.ok) {
      throw new Error(`Telegram sendMessage failed: HTTP ${response.status}`);
    }

    const payload = await response.json() as TelegramSendMessageResponse;
    if (!payload.ok) {
      throw new Error(payload.description || 'Telegram sendMessage failed');
    }

    return payload;
  }

  private buildApiUrl(method: string): string {
    return `${TELEGRAM_API_BASE}/bot${this.plugin.settings.telegram.botToken.trim()}/${method}`;
  }

  private splitTelegramMessage(text: string): string[] {
    const normalized = text.trim() || 'Execution completed.';
    const maxLength = 3800;
    if (normalized.length <= maxLength) {
      return [normalized];
    }

    const chunks: string[] = [];
    let remaining = normalized;
    while (remaining.length > maxLength) {
      const slice = remaining.slice(0, maxLength);
      const splitAt = Math.max(slice.lastIndexOf('\n\n'), slice.lastIndexOf('\n'), slice.lastIndexOf(' '));
      const safeIndex = splitAt > 1000 ? splitAt : maxLength;
      chunks.push(remaining.slice(0, safeIndex).trim());
      remaining = remaining.slice(safeIndex).trim();
    }
    if (remaining) {
      chunks.push(remaining);
    }
    return chunks;
  }

  private async runExecutionWithTimeout<T>(chatKey: string, task: Promise<T>): Promise<T> {
    return await new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.remoteExecution.cancel(chatKey);
        reject(new Error('Execution timed out. The previous request was cancelled to unblock this chat.'));
      }, TELEGRAM_EXECUTION_TIMEOUT_MS);

      task
        .then((result) => {
          window.clearTimeout(timer);
          resolve(result);
        })
        .catch((error) => {
          window.clearTimeout(timer);
          reject(error);
        });
    });
  }

  private async extractTelegramImages(message: TelegramMessage): Promise<ImageAttachment[]> {
    const photoAttachment = this.selectPhotoAttachment(message);
    if (photoAttachment) {
      return [await this.downloadTelegramImage(message.message_id, photoAttachment)];
    }

    const documentAttachment = this.selectDocumentAttachment(message);
    if (documentAttachment) {
      return [await this.downloadTelegramImage(message.message_id, documentAttachment)];
    }

    return [];
  }

  private async extractTelegramImagesFromBatch(messages: TelegramMessage[]): Promise<ImageAttachment[]> {
    const imageSets = await Promise.all(messages.map((message) => this.extractTelegramImages(message)));
    return imageSets.flat();
  }

  private async fetchTelegramFile(fileId: string): Promise<TelegramFileInfo> {
    try {
      const response = await requestUrl({
        url: this.buildApiUrl('getFile'),
        method: 'POST',
        contentType: 'application/json',
        body: JSON.stringify({ file_id: fileId }),
        throw: false,
      });

      if (response.status >= 400) {
        throw new Error(`Telegram getFile failed: HTTP ${response.status}`);
      }

      const payload = response.json as {
        ok: boolean;
        result?: TelegramFileInfo;
        description?: string;
      };

      if (!payload.ok || !payload.result) {
        throw new Error(payload.description || 'Telegram getFile failed');
      }

      return payload.result;
    } catch (error) {
      throw new Error(`Telegram image step failed at getFile: ${this.normalizeNetworkError(error)}`);
    }
  }

  private inferMediaType(filePath: string): ImageMediaType {
    const normalized = filePath.toLowerCase();
    if (normalized.endsWith('.png')) return 'image/png';
    if (normalized.endsWith('.gif')) return 'image/gif';
    if (normalized.endsWith('.webp')) return 'image/webp';
    return 'image/jpeg';
  }

  private extractBatchText(messages: TelegramMessage[]): string {
    for (const message of messages) {
      const text = (message.text ?? message.caption ?? '').trim();
      if (text) {
        return text;
      }
    }
    return '';
  }

  private collectUnsupportedMediaHints(messages: TelegramMessage[]): string[] {
    const hints: string[] = [];

    for (const message of messages) {
      if (message.sticker) {
        const stickerKind = message.sticker.is_video ? 'video sticker' : message.sticker.is_animated ? 'animated sticker' : 'sticker';
        const emojiSuffix = message.sticker.emoji ? ` ${message.sticker.emoji}` : '';
        hints.push(`Telegram ${stickerKind} received${emojiSuffix}.`);
      }
      if (message.animation) {
        hints.push('Telegram animation received.');
      }
      if (message.video_note) {
        hints.push('Telegram video note received.');
      }
    }

    return [...new Set(hints)];
  }

  private buildExecutionPrompt(
    textContent: string,
    imageCount: number,
    messages: TelegramMessage[],
    unsupportedHints: string[],
  ): string {
    const parts: string[] = [];
    const mediaGroupId = messages.find((message) => message.media_group_id)?.media_group_id;

    if (mediaGroupId && imageCount > 1) {
      parts.push(`Telegram album with ${imageCount} images.`);
    }

    if (unsupportedHints.length > 0) {
      parts.push(...unsupportedHints);
    }

    if (textContent) {
      parts.push(textContent);
    }

    if (parts.length === 0 && imageCount > 0) {
      return mediaGroupId && imageCount > 1
        ? `Telegram album with ${imageCount} images.`
        : 'Telegram image received.';
    }

    return parts.join('\n\n').trim();
  }

  private selectPhotoAttachment(message: TelegramMessage): {
    fileId: string;
    fileUniqueId: string;
    width?: number;
    height?: number;
    fallbackName: string;
  } | null {
    const photos = message.photo;
    if (!photos || photos.length === 0) {
      return null;
    }

    const largest = [...photos].sort((left, right) => {
      const leftSize = (left.file_size ?? 0) || (left.width * left.height);
      const rightSize = (right.file_size ?? 0) || (right.width * right.height);
      return rightSize - leftSize;
    })[0];

    if (!largest) {
      return null;
    }

    return {
      fileId: largest.file_id,
      fileUniqueId: largest.file_unique_id,
      width: largest.width,
      height: largest.height,
      fallbackName: `telegram-${message.message_id}.jpg`,
    };
  }

  private selectDocumentAttachment(message: TelegramMessage): {
    fileId: string;
    fileUniqueId: string;
    width?: number;
    height?: number;
    fallbackName: string;
  } | null {
    const document = message.document;
    if (!document || !this.isSupportedImageDocument(document)) {
      return null;
    }

    return {
      fileId: document.file_id,
      fileUniqueId: document.file_unique_id,
      width: document.width,
      height: document.height,
      fallbackName: document.file_name || `telegram-${message.message_id}.jpg`,
    };
  }

  private isSupportedImageDocument(document: TelegramDocument): boolean {
    const mimeType = document.mime_type?.toLowerCase();
    if (mimeType === 'image/jpeg' || mimeType === 'image/png' || mimeType === 'image/gif' || mimeType === 'image/webp') {
      return true;
    }

    const fileName = document.file_name?.toLowerCase() || '';
    return fileName.endsWith('.jpg')
      || fileName.endsWith('.jpeg')
      || fileName.endsWith('.png')
      || fileName.endsWith('.gif')
      || fileName.endsWith('.webp');
  }

  private async downloadTelegramImage(
    messageId: number,
    attachment: {
      fileId: string;
      fileUniqueId: string;
      width?: number;
      height?: number;
      fallbackName: string;
    },
  ): Promise<ImageAttachment> {
    const file = await this.fetchTelegramFile(attachment.fileId);
    if (!file.file_path) {
      throw new Error('Telegram returned a file without a downloadable path.');
    }

    const mediaType = this.inferMediaType(file.file_path);
    const fileUrl = `${TELEGRAM_API_BASE}/file/bot${this.plugin.settings.telegram.botToken.trim()}/${file.file_path}`;
    let buffer: Buffer;

    try {
      const response = await requestUrl({
        url: fileUrl,
        method: 'GET',
        throw: false,
      });

      if (response.status >= 400) {
        throw new Error(`Telegram file download failed: HTTP ${response.status}`);
      }

      buffer = Buffer.from(response.arrayBuffer);
    } catch (error) {
      throw new Error(`Telegram image step failed at download file: ${this.normalizeNetworkError(error)}`);
    }

    return {
      id: `telegram-img-${messageId}-${attachment.fileUniqueId}`,
      name: file.file_path.split('/').pop() || attachment.fallbackName,
      mediaType,
      data: buffer.toString('base64'),
      size: buffer.length,
      width: attachment.width,
      height: attachment.height,
      source: 'file',
    };
  }

  private async fetchWithTimeout(input: string, init: RequestInit): Promise<Response> {
    const timeoutController = new AbortController();
    const timeoutId = window.setTimeout(() => timeoutController.abort(), TELEGRAM_REQUEST_TIMEOUT_MS);
    const externalSignal = init.signal;

    try {
      const signal = this.mergeAbortSignals(externalSignal, timeoutController.signal);
      return await fetch(input, { ...init, signal });
    } catch (error) {
      if (timeoutController.signal.aborted) {
        throw new Error('Connection timed out while contacting Telegram.');
      }
      if (error instanceof Error && error.name === 'AbortError') {
        throw error;
      }
      throw new Error(this.normalizeNetworkError(error));
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  private mergeAbortSignals(
    left?: AbortSignal | null,
    right?: AbortSignal | null,
  ): AbortSignal | undefined {
    if (!left) return right ?? undefined;
    if (!right) return left;

    const controller = new AbortController();
    const abort = () => controller.abort();
    left.addEventListener('abort', abort, { once: true });
    right.addEventListener('abort', abort, { once: true });
    return controller.signal;
  }

  private normalizeNetworkError(error: unknown): string {
    if (error instanceof Error) {
      if (error.message === 'Failed to fetch') {
        return 'Failed to connect to Telegram. Check your network, proxy, firewall, or VPN.';
      }
      return error.message;
    }
    return String(error);
  }

  private async delay(ms: number, signal: AbortSignal): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(resolve, ms);
      const abortHandler = () => {
        window.clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      };

      signal.addEventListener('abort', abortHandler, { once: true });
    }).catch(() => {
      // Ignore aborts while delaying.
    });
  }
}
