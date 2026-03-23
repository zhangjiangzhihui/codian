import type { SlashCommand } from '../types';
import type { ApprovalDecision, Conversation, ExitPlanModeDecision, ImageAttachment, StreamChunk } from '../types';

export interface ApprovalCallbackOptions {
  decisionReason?: string;
  blockedPath?: string;
  agentID?: string;
}

export type ApprovalCallback = (
  toolName: string,
  input: Record<string, unknown>,
  description: string,
  options?: ApprovalCallbackOptions,
) => Promise<ApprovalDecision>;

export type AskUserQuestionCallback = (
  input: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<Record<string, string> | null>;

export interface QueryOptions {
  allowedTools?: string[];
  model?: string;
  mcpMentions?: Set<string>;
  enabledMcpServers?: Set<string>;
  forceColdStart?: boolean;
  externalContextPaths?: string[];
}

export interface EnsureReadyOptions {
  sessionId?: string;
  externalContextPaths?: string[];
  force?: boolean;
  preserveHandlers?: boolean;
}

export interface RewindResult {
  canRewind: boolean;
  error?: string;
  filesChanged?: string[];
}

export interface AgentService {
  onReadyStateChange(listener: (ready: boolean) => void): () => void;
  ensureReady(options?: EnsureReadyOptions): Promise<boolean>;
  reloadMcpServers(): Promise<void>;
  applyForkState(conv: Pick<Conversation, 'sessionId' | 'sdkSessionId' | 'forkSource'>): string | null;
  setPendingResumeAt(uuid: string | undefined): void;
  query(
    prompt: string,
    images?: ImageAttachment[],
    previousMessages?: Array<{ role: 'user' | 'assistant'; content: string }>,
    queryOptions?: QueryOptions,
  ): AsyncGenerator<StreamChunk>;
  cancel(): void;
  resetSession(): void;
  getSessionId(): string | null;
  isReady(): boolean;
  getSupportedCommands(): Promise<SlashCommand[]>;
  setSessionId(id: string | null, externalContextPaths?: string[]): void;
  consumeSessionInvalidation(): boolean;
  rewind(sdkUserUuid: string, sdkAssistantUuid: string): Promise<RewindResult>;
  closePersistentQuery(reason?: string): void;
  cleanup(): void;
  setApprovalCallback(callback: ApprovalCallback | null): void;
  setApprovalDismisser(dismisser: (() => void) | null): void;
  setAskUserQuestionCallback(callback: AskUserQuestionCallback | null): void;
  setExitPlanModeCallback(
    callback: ((input: Record<string, unknown>, signal?: AbortSignal) => Promise<ExitPlanModeDecision | null>) | null
  ): void;
  setPermissionModeSyncCallback(callback: ((sdkMode: string) => void) | null): void;
}
