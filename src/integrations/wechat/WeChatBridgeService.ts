import { requestUrl } from 'obsidian';

import type { ImageAttachment } from '../../core/types';
import type ClaudianPlugin from '../../main';
import { RemoteExecutionService } from '../telegram/RemoteExecutionService';
import { downloadWeChatImagesFromMessage } from './media';
import { DEFAULT_WECHAT_BASE_URL, DEFAULT_WECHAT_CDN_BASE_URL, loadWeChatOpenClawAccount, resolveDefaultOpenClawStateDir } from './openClawAccount';
import {
  WECHAT_MESSAGE_ITEM_TYPE,
  WECHAT_MESSAGE_STATE,
  WECHAT_MESSAGE_TYPE,
  WECHAT_TYPING_STATUS,
  type WeChatGetConfigResponse,
  type WeChatGetUpdatesResponse,
  type WeChatMessage,
  type WeChatMessageItem,
  type WeChatSendMessageResponse,
  type WeChatSendTypingResponse,
} from './types';

const RETRY_DELAY_MS = 3000;
const WECHAT_REQUEST_TIMEOUT_MS = 10000;
const WECHAT_EXECUTION_TIMEOUT_MS = 120000;
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35000;
const WECHAT_AUTH_TYPE = 'ilink_bot_token';
const WECHAT_APP_ID = 'bot';
const WECHAT_TYPING_KEEPALIVE_MS = 5000;
const WECHAT_QR_LOGIN_SESSION_TTL_MS = 5 * 60_000;
const WECHAT_QR_LOGIN_STATUS_TIMEOUT_MS = 35_000;
const WECHAT_QR_LOGIN_MAX_REFRESH_COUNT = 3;

type WeChatQrLoginRawStatus = 'wait' | 'scaned' | 'confirmed' | 'expired' | 'scaned_but_redirect';
type WeChatQrLoginStatus = 'idle' | 'waiting' | 'scanned' | 'confirmed' | 'expired' | 'failed';

interface WeChatQrCodeResponse {
  qrcode?: string;
  qrcode_img_content?: string;
}

interface WeChatQrStatusResponse {
  status?: WeChatQrLoginRawStatus;
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
  redirect_host?: string;
}

interface ActiveWeChatQrLogin {
  sessionKey: string;
  qrcode: string;
  qrCodeUrl: string;
  startedAt: number;
  refreshCount: number;
  pollBaseUrl: string;
  status: WeChatQrLoginStatus;
  message: string;
}

export interface WeChatQrLoginState {
  active: boolean;
  sessionKey?: string;
  qrCodeUrl?: string;
  status: WeChatQrLoginStatus;
  message: string;
  accountId?: string;
  userId?: string;
}

export interface WeChatQrLoginPollResult extends WeChatQrLoginState {
  connected: boolean;
  configUpdated: boolean;
}

export class WeChatBridgeService {
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
  private nextPollTimeoutMs = DEFAULT_LONG_POLL_TIMEOUT_MS;
  private activeQrLogin: ActiveWeChatQrLogin | null = null;
  private qrLoginPollPromise: Promise<WeChatQrLoginPollResult> | null = null;
  private qrLoginEpoch = 0;
  private lastQrLoginState: WeChatQrLoginState = {
    active: false,
    status: 'idle',
    message: 'No active WeChat QR login.',
  };

  constructor(private plugin: ClaudianPlugin) {
    this.remoteExecution = new RemoteExecutionService(plugin, {
      getConversationId: (chatKey) => this.plugin.settings.wechat.chatConversationMap[chatKey],
      setConversationId: (chatKey, conversationId) => {
        this.plugin.settings.wechat.chatConversationMap[chatKey] = conversationId;
      },
      messageIdPrefix: 'wechat',
    });
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
    this.nextPollTimeoutMs = this.getConfiguredPollTimeoutMs();
    this.configKey = '';
    this.plugin.settings.wechat.syncCursor = '';
    await this.plugin.saveSettings();
    await this.sync();
  }

  async importAccountFromOpenClaw(accountId?: string, stateDir?: string): Promise<string> {
    const imported = loadWeChatOpenClawAccount({
      accountId,
      stateDir: stateDir?.trim() || this.getOpenClawStateDir(),
    });

    this.plugin.settings.wechat.accountId = imported.accountId;
    this.plugin.settings.wechat.baseUrl = imported.baseUrl || DEFAULT_WECHAT_BASE_URL;
    this.plugin.settings.wechat.cdnBaseUrl = imported.cdnBaseUrl || DEFAULT_WECHAT_CDN_BASE_URL;
    this.plugin.settings.wechat.botToken = imported.token;
    this.plugin.settings.wechat.routeTag = imported.routeTag ?? '';
    this.plugin.settings.wechat.openClawStateDir = imported.stateDir;
    await this.plugin.saveSettings();
    return `Imported WeChat account ${imported.accountId} from ${imported.stateDir}.`;
  }

  getDefaultOpenClawStateDir(): string {
    return resolveDefaultOpenClawStateDir();
  }

  getQrLoginState(): WeChatQrLoginState {
    if (!this.activeQrLogin) {
      return { ...this.lastQrLoginState };
    }

    if (!this.isQrLoginFresh(this.activeQrLogin)) {
      this.clearQrLoginSession({
        active: false,
        status: 'expired',
        message: 'WeChat QR login timed out. Generate a new QR code.',
      });
      return { ...this.lastQrLoginState };
    }

    return this.snapshotQrLoginState(this.activeQrLogin);
  }

  async startQrLogin(force = false): Promise<WeChatQrLoginState> {
    if (!force && this.activeQrLogin && this.isQrLoginFresh(this.activeQrLogin)) {
      const snapshot = this.snapshotQrLoginState(this.activeQrLogin);
      this.lastQrLoginState = snapshot;
      return snapshot;
    }

    const response = await this.fetchQrCode(DEFAULT_WECHAT_BASE_URL);
    const qrCode = response.qrcode?.trim();
    const qrCodeUrl = this.normalizeQrCodeImageSource(response.qrcode_img_content);

    if (!qrCode || !qrCodeUrl) {
      const failure = {
        active: false,
        status: 'failed' as const,
        message: 'Failed to generate a WeChat QR code. The upstream gateway returned an incomplete response.',
      };
      this.clearQrLoginSession(failure);
      return failure;
    }

    this.qrLoginEpoch += 1;
    this.qrLoginPollPromise = null;
    this.activeQrLogin = {
      sessionKey: this.generateQrLoginSessionKey(),
      qrcode: qrCode,
      qrCodeUrl,
      startedAt: Date.now(),
      refreshCount: 1,
      pollBaseUrl: DEFAULT_WECHAT_BASE_URL,
      status: 'waiting',
      message: 'Scan the QR code with WeChat, then confirm the login in the app.',
    };
    this.lastQrLoginState = this.snapshotQrLoginState(this.activeQrLogin);
    return { ...this.lastQrLoginState };
  }

  async pollQrLogin(sessionKey?: string): Promise<WeChatQrLoginPollResult> {
    if (this.qrLoginPollPromise) {
      return await this.qrLoginPollPromise;
    }

    this.qrLoginPollPromise = this.pollQrLoginInternal(sessionKey).finally(() => {
      this.qrLoginPollPromise = null;
    });
    return await this.qrLoginPollPromise;
  }

  start(): void {
    if (this.running || !this.shouldRun()) return;
    this.running = true;
    this.lastError = null;
    this.nextPollTimeoutMs = this.getConfiguredPollTimeoutMs();
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

  async testConnection(): Promise<string> {
    const { botToken, baseUrl } = this.plugin.settings.wechat;
    if (!botToken.trim()) {
      this.lastError = 'WeChat bot token is empty.';
      return this.lastError;
    }
    if (!baseUrl.trim()) {
      this.lastError = 'WeChat base URL is empty.';
      return this.lastError;
    }

    try {
      await this.fetchUpdates(new AbortController().signal, {
        cursor: this.plugin.settings.wechat.syncCursor,
        timeoutMs: 2000,
        acceptTimeoutAsSuccess: true,
      });
      this.lastError = null;
      this.lastSuccessAt = Date.now();
      return 'WeChat bridge can reach the upstream gateway.';
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      return this.lastError;
    }
  }

  getStatusSummary(): string {
    const { enabled, botToken, baseUrl, accountId } = this.plugin.settings.wechat;
    if (!enabled) {
      return 'Disabled';
    }
    if (!baseUrl.trim()) {
      return 'Enabled, but base URL is missing';
    }
    if (!botToken.trim()) {
      return 'Enabled, but bot token is missing';
    }
    if (this.lastError) {
      return `Connection issue: ${this.lastError}`;
    }

    const statusBits: string[] = [];
    if (accountId.trim()) {
      statusBits.push(`account: ${accountId.trim()}`);
    }
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
    statusBits.unshift(this.running ? 'Running' : 'Enabled');
    return statusBits.join(' | ');
  }

  private shouldRun(): boolean {
    const { wechat } = this.plugin.settings;
    return wechat.enabled && wechat.baseUrl.trim().length > 0 && wechat.botToken.trim().length > 0;
  }

  private async pollQrLoginInternal(sessionKey?: string): Promise<WeChatQrLoginPollResult> {
    const session = this.activeQrLogin;
    const pollEpoch = this.qrLoginEpoch;
    if (!session) {
      const state = this.getQrLoginState();
      return {
        ...state,
        connected: false,
        configUpdated: false,
      };
    }

    if (sessionKey && session.sessionKey !== sessionKey) {
      return {
        ...this.snapshotQrLoginState(session),
        connected: false,
        configUpdated: false,
      };
    }

    if (!this.isQrLoginFresh(session)) {
      const expired = {
        active: false,
        status: 'expired' as const,
        message: 'WeChat QR login timed out. Generate a new QR code.',
      };
      this.clearQrLoginSession(expired);
      return {
        ...expired,
        connected: false,
        configUpdated: false,
      };
    }

    const response = await this.fetchQrStatus(session.pollBaseUrl, session.qrcode);
    if (!this.isCurrentQrLoginSession(session, pollEpoch)) {
      const state = this.getQrLoginState();
      return {
        ...state,
        connected: false,
        configUpdated: false,
      };
    }
    const nextStatus = response.status ?? 'wait';

    switch (nextStatus) {
      case 'wait': {
        session.status = 'waiting';
        session.message = 'Waiting for WeChat to scan the QR code.';
        this.lastQrLoginState = this.snapshotQrLoginState(session);
        return {
          ...this.lastQrLoginState,
          connected: false,
          configUpdated: false,
        };
      }
      case 'scaned': {
        session.status = 'scanned';
        session.message = 'QR code scanned. Confirm the login inside WeChat.';
        this.lastQrLoginState = this.snapshotQrLoginState(session);
        return {
          ...this.lastQrLoginState,
          connected: false,
          configUpdated: false,
        };
      }
      case 'scaned_but_redirect': {
        if (response.redirect_host?.trim()) {
          session.pollBaseUrl = `https://${response.redirect_host.trim()}`;
        }
        session.status = 'scanned';
        session.message = 'QR code scanned. Switching the polling host and waiting for confirmation.';
        this.lastQrLoginState = this.snapshotQrLoginState(session);
        return {
          ...this.lastQrLoginState,
          connected: false,
          configUpdated: false,
        };
      }
      case 'expired': {
        if (session.refreshCount >= WECHAT_QR_LOGIN_MAX_REFRESH_COUNT) {
          const expired = {
            active: false,
            status: 'expired' as const,
            message: 'The WeChat QR code expired too many times. Generate a new one and try again.',
          };
          this.clearQrLoginSession(expired);
          return {
            ...expired,
            connected: false,
            configUpdated: false,
          };
        }

        try {
          const refreshed = await this.fetchQrCode(DEFAULT_WECHAT_BASE_URL);
          const qrCode = refreshed.qrcode?.trim();
          const qrCodeUrl = this.normalizeQrCodeImageSource(refreshed.qrcode_img_content);
          if (!qrCode || !qrCodeUrl) {
            throw new Error('Upstream returned an incomplete QR code refresh response.');
          }

          session.qrcode = qrCode;
          session.qrCodeUrl = qrCodeUrl;
          session.startedAt = Date.now();
          session.refreshCount += 1;
          session.pollBaseUrl = DEFAULT_WECHAT_BASE_URL;
          session.status = 'waiting';
          session.message = 'The QR code expired. A fresh QR code has been generated.';
          this.lastQrLoginState = this.snapshotQrLoginState(session);
          return {
            ...this.lastQrLoginState,
            connected: false,
            configUpdated: false,
          };
        } catch (error) {
          const failure = {
            active: false,
            status: 'failed' as const,
            message: error instanceof Error ? error.message : String(error),
          };
          this.clearQrLoginSession(failure);
          return {
            ...failure,
            connected: false,
            configUpdated: false,
          };
        }
      }
      case 'confirmed': {
        const token = response.bot_token?.trim();
        const accountId = response.ilink_bot_id?.trim();
        const baseUrl = response.baseurl?.trim() || session.pollBaseUrl || DEFAULT_WECHAT_BASE_URL;
        const userId = response.ilink_user_id?.trim();

        if (!token || !accountId) {
          const failure = {
            active: false,
            status: 'failed' as const,
            message: 'WeChat confirmed the login, but the upstream response did not include a bot token or account ID.',
          };
          this.clearQrLoginSession(failure);
          return {
            ...failure,
            connected: false,
            configUpdated: false,
          };
        }

        this.plugin.settings.wechat.accountId = accountId;
        this.plugin.settings.wechat.baseUrl = baseUrl;
        this.plugin.settings.wechat.botToken = token;
        this.plugin.settings.wechat.cdnBaseUrl = this.plugin.settings.wechat.cdnBaseUrl.trim() || DEFAULT_WECHAT_CDN_BASE_URL;
        this.plugin.settings.wechat.syncCursor = '';
        this.plugin.settings.wechat.enabled = true;
        await this.plugin.saveSettings();

        const allowlistBlocked = userId
          && this.plugin.settings.wechat.allowedUserIds.length > 0
          && !this.plugin.settings.wechat.allowedUserIds.includes(userId);
        const message = allowlistBlocked
          ? `WeChat login confirmed for ${accountId}. The bridge is enabled, but the current allowlist does not include ${userId}. Add that user ID below before sending messages.`
          : `WeChat login confirmed for ${accountId}. The bridge is enabled and ready.`;
        const success = {
          active: false,
          status: 'confirmed' as const,
          message,
          accountId,
          userId,
        };
        this.clearQrLoginSession(success);
        return {
          ...success,
          connected: true,
          configUpdated: true,
        };
      }
      default: {
        const failure = {
          active: false,
          status: 'failed' as const,
          message: `Unexpected WeChat QR login status: ${String(nextStatus)}`,
        };
        this.clearQrLoginSession(failure);
        return {
          ...failure,
          connected: false,
          configUpdated: false,
        };
      }
    }
  }

  private getConfigKey(): string {
    const { wechat } = this.plugin.settings;
    return JSON.stringify({
      enabled: wechat.enabled,
      baseUrl: wechat.baseUrl.trim(),
      cdnBaseUrl: wechat.cdnBaseUrl.trim(),
      token: wechat.botToken.trim(),
      routeTag: wechat.routeTag.trim(),
      users: [...wechat.allowedUserIds].sort(),
      timeout: wechat.pollTimeoutSeconds,
    });
  }

  private async pollLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted && this.shouldRun()) {
      try {
        const response = await this.fetchUpdates(signal, {
          cursor: this.plugin.settings.wechat.syncCursor,
          timeoutMs: Math.max(this.nextPollTimeoutMs + 5000, WECHAT_REQUEST_TIMEOUT_MS),
        });

        const nextCursor = response.get_updates_buf ?? this.plugin.settings.wechat.syncCursor;
        const messages = (response.msgs || []).filter((message) => this.shouldProcessMessage(message));
        if (messages.length > 0) {
          this.lastUpdateReceivedAt = Date.now();
        }
        for (const message of messages) {
          if (signal.aborted) return;
          await this.handleMessage(message);
        }

        this.nextPollTimeoutMs = this.normalizePollTimeoutMs(response.longpolling_timeout_ms);
        if (nextCursor !== this.plugin.settings.wechat.syncCursor) {
          this.plugin.settings.wechat.syncCursor = nextCursor;
          await this.plugin.saveSettings();
        }
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        this.lastError = error instanceof Error ? error.message : String(error);
        console.error('[Codian][WeChat] Polling failed', error);
        await this.delay(RETRY_DELAY_MS, signal);
      }
    }
  }

  private shouldProcessMessage(message: WeChatMessage): boolean {
    if (!message.from_user_id?.trim()) {
      return false;
    }
    if (message.message_type !== undefined && message.message_type !== WECHAT_MESSAGE_TYPE.USER) {
      return false;
    }
    return true;
  }

  private async fetchUpdates(
    signal: AbortSignal,
    options?: {
      cursor?: string;
      timeoutMs?: number;
      acceptTimeoutAsSuccess?: boolean;
    },
  ): Promise<WeChatGetUpdatesResponse> {
    try {
      const response = await this.postJson<WeChatGetUpdatesResponse>(
        'ilink/bot/getupdates',
        {
          get_updates_buf: options?.cursor ?? '',
          base_info: this.buildBaseInfo(),
        },
        options?.timeoutMs ?? Math.max(this.nextPollTimeoutMs + 5000, WECHAT_REQUEST_TIMEOUT_MS),
        signal,
      );

      if ((response.ret ?? 0) !== 0) {
        if (response.errcode === -14) {
          throw new Error('WeChat session expired. Refresh the ClawBot login or re-import the OpenClaw account token.');
        }
        throw new Error(response.errmsg || `WeChat getUpdates failed: ret=${response.ret ?? 'unknown'}`);
      }

      this.lastError = null;
      this.lastSuccessAt = Date.now();
      return response;
    } catch (error) {
      if (options?.acceptTimeoutAsSuccess && error instanceof Error && error.message === 'Connection timed out while contacting WeChat.') {
        this.lastError = null;
        this.lastSuccessAt = Date.now();
        return {
          ret: 0,
          msgs: [],
          get_updates_buf: options.cursor ?? '',
        };
      }
      throw error;
    }
  }

  private async handleMessage(message: WeChatMessage): Promise<void> {
    const userId = message.from_user_id?.trim();
    if (!userId) {
      this.lastSkipReason = 'message has no sender';
      return;
    }

    if (!this.isAuthorized(userId)) {
      this.lastSkipReason = `message blocked by allowlist: user=${userId}`;
      await this.safeReply(userId, message.context_token, 'Unauthorized WeChat user.');
      return;
    }

    const chatKey = userId;
    const textContent = this.extractMessageText(message.item_list);
    const unsupportedHints = this.collectUnsupportedMediaHints(message.item_list);

    if (textContent === '/start' || textContent === '/help') {
      await this.safeReply(userId, message.context_token, 'Send a message to execute it in Codian. Use /new to start a fresh conversation or /stop to cancel the current run.');
      this.lastSkipReason = null;
      return;
    }

    if (textContent === '/new') {
      delete this.plugin.settings.wechat.chatConversationMap[chatKey];
      await this.plugin.saveSettings();
      await this.safeReply(userId, message.context_token, 'A new Codian conversation will be used for your next message.');
      this.lastSkipReason = null;
      return;
    }

    if (textContent === '/stop') {
      const cancelled = this.remoteExecution.cancel(chatKey);
      await this.safeReply(userId, message.context_token, cancelled ? 'Current execution cancelled.' : 'No active execution for this chat.');
      this.lastSkipReason = null;
      return;
    }

    if (this.activeChats.has(chatKey)) {
      const startedAt = this.activeChatStartedAt.get(chatKey) ?? Date.now();
      if (Date.now() - startedAt > WECHAT_EXECUTION_TIMEOUT_MS) {
        this.remoteExecution.cancel(chatKey);
        this.activeChats.delete(chatKey);
        this.activeChatStartedAt.delete(chatKey);
      } else {
        this.lastSkipReason = 'chat is busy with a previous request';
        await this.safeReply(userId, message.context_token, 'A previous request is still running for this chat. Wait for it to finish or send /stop.');
        return;
      }
    }

    this.activeChats.add(chatKey);
    this.activeChatStartedAt.set(chatKey, Date.now());
    try {
      const stopTyping = await this.startTypingSession(userId, message.context_token);
      try {
        const images = await this.extractWeChatImages(message);
        if (!textContent && unsupportedHints.length > 0 && images.length === 0) {
          this.lastSkipReason = 'message contains unsupported media only';
          await this.safeReply(userId, message.context_token, 'This WeChat bridge currently supports text and image messages. Keep using Telegram for files, raw voice, and video.');
          return;
        }

        const promptText = this.buildExecutionPrompt(textContent, images.length, unsupportedHints);
        if (!promptText && images.length === 0) {
          this.lastSkipReason = 'message has no supported text or image content';
          return;
        }

        this.lastMessageHandledAt = Date.now();
        this.lastSkipReason = null;
        await this.safeReply(userId, message.context_token, 'Request received. Running in Codian now.');
        const conversationId = this.plugin.settings.wechat.chatConversationMap[chatKey];
        const result = await this.runExecutionWithTimeout(
          chatKey,
          this.remoteExecution.execute(chatKey, promptText, conversationId, images, promptText),
        );
        this.plugin.settings.wechat.chatConversationMap[chatKey] = result.conversationId;
        await this.plugin.saveSettings();
        await this.safeReply(userId, message.context_token, result.replyText);
      } finally {
        await stopTyping();
      }
    } catch (error) {
      const description = error instanceof Error ? error.message : String(error);
      await this.safeReply(userId, message.context_token, `Execution failed:\n${description}`);
    } finally {
      this.activeChats.delete(chatKey);
      this.activeChatStartedAt.delete(chatKey);
    }
  }

  private isAuthorized(userId: string): boolean {
    const allowedUsers = this.plugin.settings.wechat.allowedUserIds;
    if (allowedUsers.length > 0 && !allowedUsers.includes(userId)) {
      return false;
    }
    return true;
  }

  private async safeReply(userId: string, contextToken: string | undefined, text: string): Promise<void> {
    try {
      await this.sendMessage(userId, contextToken, text.trim() || 'Execution completed.');
    } catch (error) {
      console.error('[Codian][WeChat] sendMessage failed', error);
    }
  }

  private async sendMessage(userId: string, contextToken: string | undefined, text: string): Promise<void> {
    const response = await this.postJson<WeChatSendMessageResponse>(
      'ilink/bot/sendmessage',
      {
        msg: {
          from_user_id: '',
          to_user_id: userId,
          client_id: this.generateClientId(),
          message_type: WECHAT_MESSAGE_TYPE.BOT,
          message_state: WECHAT_MESSAGE_STATE.FINISH,
          item_list: [
            {
              type: WECHAT_MESSAGE_ITEM_TYPE.TEXT,
              text_item: { text },
            },
          ],
          context_token: contextToken || undefined,
        },
        base_info: this.buildBaseInfo(),
      },
      WECHAT_REQUEST_TIMEOUT_MS,
    );

    if ((response.ret ?? 0) !== 0) {
      throw new Error(response.errmsg || `WeChat sendMessage failed: ret=${response.ret ?? 'unknown'}`);
    }
  }

  private extractMessageText(items?: WeChatMessageItem[]): string {
    if (!items || items.length === 0) {
      return '';
    }

    for (const item of items) {
      if (item.type === WECHAT_MESSAGE_ITEM_TYPE.TEXT && item.text_item?.text) {
        const text = item.text_item.text.trim();
        if (text) {
          return text;
        }
      }
      if (item.type === WECHAT_MESSAGE_ITEM_TYPE.VOICE && item.voice_item?.text) {
        const text = item.voice_item.text.trim();
        if (text) {
          return text;
        }
      }
    }

    return '';
  }

  private collectUnsupportedMediaHints(items?: WeChatMessageItem[]): string[] {
    if (!items || items.length === 0) {
      return [];
    }

    const hints: string[] = [];
    for (const item of items) {
      if (item.type === WECHAT_MESSAGE_ITEM_TYPE.FILE) {
        hints.push('WeChat file received, but Codian cannot inspect arbitrary file attachments through this bridge yet.');
      } else if (item.type === WECHAT_MESSAGE_ITEM_TYPE.VIDEO) {
        hints.push('WeChat video received, but Codian cannot inspect video attachments through this bridge yet.');
      } else if (item.type === WECHAT_MESSAGE_ITEM_TYPE.VOICE && !item.voice_item?.text?.trim()) {
        hints.push('WeChat voice message received, but Codian cannot transcribe raw voice through this bridge yet.');
      }
    }

    return [...new Set(hints)];
  }

  private buildExecutionPrompt(textContent: string, imageCount: number, unsupportedHints: string[]): string {
    const parts: string[] = [];
    if (imageCount > 1) {
      parts.push(`WeChat album with ${imageCount} images.`);
    }
    if (unsupportedHints.length > 0) {
      parts.push(...unsupportedHints);
    }
    if (textContent) {
      parts.push(textContent);
    }
    if (parts.length === 0 && imageCount > 0) {
      return imageCount > 1 ? `WeChat album with ${imageCount} images.` : 'WeChat image received.';
    }
    return parts.join('\n\n').trim();
  }

  private async extractWeChatImages(message: WeChatMessage): Promise<ImageAttachment[]> {
    return await downloadWeChatImagesFromMessage(
      message,
      this.plugin.settings.wechat.cdnBaseUrl.trim() || DEFAULT_WECHAT_CDN_BASE_URL,
    );
  }

  private async runExecutionWithTimeout<T>(chatKey: string, task: Promise<T>): Promise<T> {
    return await new Promise<T>((resolve, reject) => {
      const timer = globalThis.setTimeout(() => {
        this.remoteExecution.cancel(chatKey);
        reject(new Error('Execution timed out. The previous request was cancelled to unblock this chat.'));
      }, WECHAT_EXECUTION_TIMEOUT_MS);

      task
        .then((result) => {
          globalThis.clearTimeout(timer);
          resolve(result);
        })
        .catch((error) => {
          globalThis.clearTimeout(timer);
          reject(error);
        });
    });
  }

  private buildBaseInfo(): { channel_version: string } {
    return {
      channel_version: this.plugin.manifest.version,
    };
  }

  private snapshotQrLoginState(session: ActiveWeChatQrLogin): WeChatQrLoginState {
    return {
      active: true,
      sessionKey: session.sessionKey,
      qrCodeUrl: session.qrCodeUrl,
      status: session.status,
      message: session.message,
    };
  }

  private buildApiUrl(endpoint: string): string {
    const baseUrl = this.plugin.settings.wechat.baseUrl.trim() || DEFAULT_WECHAT_BASE_URL;
    return new URL(endpoint, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
  }

  private buildUrlFromBase(baseUrl: string, endpoint: string): string {
    return new URL(endpoint, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      AuthorizationType: WECHAT_AUTH_TYPE,
      'X-WECHAT-UIN': this.randomWechatUin(),
      'iLink-App-Id': WECHAT_APP_ID,
      'iLink-App-ClientVersion': String(this.buildClientVersion(this.plugin.manifest.version)),
    };
    const token = this.plugin.settings.wechat.botToken.trim();
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    const routeTag = this.plugin.settings.wechat.routeTag.trim();
    if (routeTag) {
      headers.SKRouteTag = routeTag;
    }
    return headers;
  }

  private async postJson<T>(
    endpoint: string,
    body: unknown,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<T> {
    const raw = await this.requestText(
      {
        url: this.buildApiUrl(endpoint),
        method: 'POST',
        contentType: 'application/json',
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
        throw: false,
      },
      timeoutMs,
      signal,
    );

    if (!raw.trim()) {
      return {} as T;
    }

    return JSON.parse(raw) as T;
  }

  private async getJson<T>(url: string, timeoutMs: number, signal?: AbortSignal): Promise<T> {
    const raw = await this.requestText(
      {
        url,
        method: 'GET',
        headers: {
          Accept: 'application/json',
        },
        throw: false,
      },
      timeoutMs,
      signal,
    );

    if (!raw.trim()) {
      return {} as T;
    }

    return JSON.parse(raw) as T;
  }

  private async requestText(
    request: {
      url: string;
      method: string;
      headers?: Record<string, string>;
      body?: string;
      contentType?: string;
      throw: false;
    },
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<string> {
    const requestPromise = requestUrl(request);

    try {
      const response = await this.awaitRequestWithTimeout(requestPromise, timeoutMs, signal);
      if (response.status >= 400) {
        throw new Error(`WeChat API request failed: HTTP ${response.status}`);
      }
      return response.text || '';
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw error;
      }
      throw new Error(this.normalizeNetworkError(error));
    }
  }

  private async awaitRequestWithTimeout<T>(
    task: Promise<T>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<T> {
    return await new Promise<T>((resolve, reject) => {
      const timeoutId = globalThis.setTimeout(() => {
        cleanup();
        reject(new Error('Connection timed out while contacting WeChat.'));
      }, timeoutMs);

      const abortHandler = () => {
        cleanup();
        reject(new DOMException('Aborted', 'AbortError'));
      };

      const cleanup = () => {
        globalThis.clearTimeout(timeoutId);
        signal?.removeEventListener('abort', abortHandler);
      };

      if (signal?.aborted) {
        cleanup();
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }

      signal?.addEventListener('abort', abortHandler, { once: true });

      task
        .then((result) => {
          cleanup();
          resolve(result);
        })
        .catch((error) => {
          cleanup();
          reject(error);
        });
    });
  }

  private normalizeNetworkError(error: unknown): string {
    if (error instanceof Error) {
      if (error.message.startsWith('WeChat API request failed: HTTP ')) {
        return error.message;
      }
      if (error.message === 'Failed to fetch') {
        return 'Failed to connect to the WeChat gateway. Check your network or upstream base URL.';
      }
      return error.message;
    }
    return String(error);
  }

  private normalizePollTimeoutMs(timeoutMs?: number): number {
    if (!timeoutMs || !Number.isFinite(timeoutMs)) {
      return this.getConfiguredPollTimeoutMs();
    }
    return Math.max(5000, Math.min(timeoutMs, 60000));
  }

  private getConfiguredPollTimeoutMs(): number {
    return Math.max(5000, this.plugin.settings.wechat.pollTimeoutSeconds * 1000);
  }

  private getOpenClawStateDir(): string {
    return this.plugin.settings.wechat.openClawStateDir.trim() || resolveDefaultOpenClawStateDir();
  }

  private async fetchQrCode(baseUrl: string): Promise<WeChatQrCodeResponse> {
    return await this.getJson<WeChatQrCodeResponse>(
      this.buildUrlFromBase(baseUrl, 'ilink/bot/get_bot_qrcode?bot_type=3'),
      WECHAT_REQUEST_TIMEOUT_MS,
    );
  }

  private async fetchQrStatus(baseUrl: string, qrCode: string): Promise<WeChatQrStatusResponse> {
    try {
      return await this.getJson<WeChatQrStatusResponse>(
        this.buildUrlFromBase(baseUrl, `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrCode)}`),
        WECHAT_QR_LOGIN_STATUS_TIMEOUT_MS,
      );
    } catch {
      return { status: 'wait' };
    }
  }

  private isQrLoginFresh(session: ActiveWeChatQrLogin): boolean {
    return Date.now() - session.startedAt < WECHAT_QR_LOGIN_SESSION_TTL_MS;
  }

  private clearQrLoginSession(state: WeChatQrLoginState): void {
    this.qrLoginEpoch += 1;
    this.qrLoginPollPromise = null;
    this.activeQrLogin = null;
    this.lastQrLoginState = { ...state };
  }

  private isCurrentQrLoginSession(session: ActiveWeChatQrLogin, pollEpoch: number): boolean {
    return this.qrLoginEpoch === pollEpoch && this.activeQrLogin?.sessionKey === session.sessionKey;
  }

  private generateQrLoginSessionKey(): string {
    return `wechat-qr-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  private normalizeQrCodeImageSource(raw: string | undefined): string | undefined {
    const value = raw?.trim();
    if (!value) {
      return undefined;
    }
    if (/^data:/i.test(value) || /^https?:\/\//i.test(value)) {
      return value;
    }
    if (/^[A-Za-z0-9+/=\r\n]+$/.test(value) && value.length >= 128) {
      return `data:image/png;base64,${value.replace(/\s+/g, '')}`;
    }
    return value;
  }

  private async startTypingSession(userId: string, contextToken?: string): Promise<() => Promise<void>> {
    try {
      const response = await this.postJson<WeChatGetConfigResponse>(
        'ilink/bot/getconfig',
        {
          ilink_user_id: userId,
          context_token: contextToken,
          base_info: this.buildBaseInfo(),
        },
        WECHAT_REQUEST_TIMEOUT_MS,
      );

      if ((response.ret ?? 0) !== 0 || !response.typing_ticket?.trim()) {
        return async () => {};
      }

      const typingTicket = response.typing_ticket.trim();
      await this.sendTypingStatus(userId, typingTicket, WECHAT_TYPING_STATUS.TYPING);
      const intervalId = globalThis.setInterval(() => {
        void this.sendTypingStatus(userId, typingTicket, WECHAT_TYPING_STATUS.TYPING).catch((error) => {
          console.error('[Codian][WeChat] typing keepalive failed', error);
        });
      }, WECHAT_TYPING_KEEPALIVE_MS);

      return async () => {
        globalThis.clearInterval(intervalId);
        try {
          await this.sendTypingStatus(userId, typingTicket, WECHAT_TYPING_STATUS.CANCEL);
        } catch (error) {
          console.error('[Codian][WeChat] typing cancel failed', error);
        }
      };
    } catch (error) {
      console.error('[Codian][WeChat] typing setup failed', error);
      return async () => {};
    }
  }

  private async sendTypingStatus(userId: string, typingTicket: string, status: number): Promise<void> {
    const response = await this.postJson<WeChatSendTypingResponse>(
      'ilink/bot/sendtyping',
      {
        ilink_user_id: userId,
        typing_ticket: typingTicket,
        status,
        base_info: this.buildBaseInfo(),
      },
      WECHAT_REQUEST_TIMEOUT_MS,
    );

    if ((response.ret ?? 0) !== 0) {
      throw new Error(response.errmsg || `WeChat sendTyping failed: ret=${response.ret ?? 'unknown'}`);
    }
  }

  private buildClientVersion(version: string): number {
    const parts = version.split('.').map((part) => Number.parseInt(part, 10));
    const major = parts[0] ?? 0;
    const minor = parts[1] ?? 0;
    const patch = parts[2] ?? 0;
    return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
  }

  private randomWechatUin(): string {
    const randomUint32 = Math.floor(Math.random() * 0x1_0000_0000);
    return Buffer.from(String(randomUint32), 'utf8').toString('base64');
  }

  private generateClientId(): string {
    return `codian-wechat-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  private async delay(ms: number, signal: AbortSignal): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = globalThis.setTimeout(resolve, ms);
      const abortHandler = () => {
        globalThis.clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      };

      signal.addEventListener('abort', abortHandler, { once: true });
    }).catch(() => {
      // Ignore aborts while delaying.
    });
  }
}
