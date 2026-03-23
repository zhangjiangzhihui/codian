import { spawn } from 'child_process';
import * as readline from 'readline';
import { cliPathRequiresNode, findNodeExecutable } from '../../utils/env';

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type ApprovalMode = 'never' | 'untrusted' | 'on-failure' | 'on-request';
export type ModelReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export type Usage = {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
};

export type AgentMessageItem = {
  id: string;
  type: 'agent_message';
  text: string;
};

export type ReasoningItem = {
  id: string;
  type: 'reasoning';
  text: string;
};

export type CommandExecutionItem = {
  id: string;
  type: 'command_execution';
  command: string;
  aggregated_output: string;
  exit_code?: number;
  status: 'in_progress' | 'completed' | 'failed';
};

export type FileChangeItem = {
  id: string;
  type: 'file_change';
  changes: Array<{ path: string; kind: 'add' | 'delete' | 'update' }>;
  status: 'completed' | 'failed';
};

export type McpToolCallItem = {
  id: string;
  type: 'mcp_tool_call';
  server: string;
  tool: string;
  arguments: unknown;
  result?: unknown;
  error?: { message: string };
  status: 'in_progress' | 'completed' | 'failed';
};

export type TodoListItem = {
  id: string;
  type: 'todo_list';
  items: Array<{ text: string; completed: boolean }>;
};

export type WebSearchItem = {
  id: string;
  type: 'web_search';
  query: string;
};

export type ErrorItem = {
  id: string;
  type: 'error';
  message: string;
};

export type ThreadItem =
  | AgentMessageItem
  | ReasoningItem
  | CommandExecutionItem
  | FileChangeItem
  | McpToolCallItem
  | TodoListItem
  | WebSearchItem
  | ErrorItem;

export type ThreadEvent =
  | { type: 'thread.started'; thread_id: string }
  | { type: 'turn.started' }
  | { type: 'turn.completed'; usage: Usage }
  | { type: 'turn.failed'; error: { message: string } }
  | { type: 'item.started'; item: ThreadItem }
  | { type: 'item.updated'; item: ThreadItem }
  | { type: 'item.completed'; item: ThreadItem }
  | { type: 'error'; message: string };

export type UserInput =
  | { type: 'text'; text: string }
  | { type: 'local_image'; path: string };

export type Input = string | UserInput[];

export type ThreadOptions = {
  model?: string;
  sandboxMode?: SandboxMode;
  workingDirectory?: string;
  additionalDirectories?: string[];
  skipGitRepoCheck?: boolean;
  modelReasoningEffort?: ModelReasoningEffort;
  networkAccessEnabled?: boolean;
  webSearchEnabled?: boolean;
  approvalPolicy?: ApprovalMode;
  dangerouslyBypassApprovalsAndSandbox?: boolean;
};

export type TurnOptions = {
  signal?: AbortSignal;
};

export type Turn = {
  items: ThreadItem[];
  finalResponse: string;
  usage: Usage | null;
};

export class Thread {
  private _id: string | null;

  constructor(
    private readonly exec: CodexExec,
    private readonly options: ThreadOptions,
    id: string | null = null,
  ) {
    this._id = id;
  }

  get id(): string | null {
    return this._id;
  }

  async runStreamed(input: Input, turnOptions: TurnOptions = {}): Promise<{ events: AsyncGenerator<ThreadEvent> }> {
    return { events: this.runStreamedInternal(input, turnOptions) };
  }

  async run(input: Input, turnOptions: TurnOptions = {}): Promise<Turn> {
    const items: ThreadItem[] = [];
    let finalResponse = '';
    let usage: Usage | null = null;

    for await (const event of this.runStreamedInternal(input, turnOptions)) {
      if (event.type === 'item.completed') {
        items.push(event.item);
        if (event.item.type === 'agent_message') {
          finalResponse = event.item.text;
        }
      } else if (event.type === 'turn.completed') {
        usage = event.usage;
      } else if (event.type === 'turn.failed') {
        throw new Error(event.error.message);
      } else if (event.type === 'error') {
        throw new Error(event.message);
      }
    }

    return { items, finalResponse, usage };
  }

  private async *runStreamedInternal(input: Input, turnOptions: TurnOptions): AsyncGenerator<ThreadEvent> {
    for await (const raw of this.exec.run({
      input,
      threadId: this._id,
      signal: turnOptions.signal,
      ...this.options,
    })) {
      const parsed = JSON.parse(raw) as ThreadEvent;
      if (parsed.type === 'thread.started') {
        this._id = parsed.thread_id;
      }
      yield parsed;
    }
  }
}

type CodexExecArgs = ThreadOptions & {
  input: Input;
  threadId?: string | null;
  signal?: AbortSignal;
};

class CodexExec {
  constructor(
    private readonly executablePath: string,
    private readonly baseUrl?: string,
    private readonly apiKey?: string,
    private readonly env?: Record<string, string>,
  ) {}

  async *run(args: CodexExecArgs): AsyncGenerator<string> {
    const { prompt, images } = normalizeInput(args.input);
    const commandArgs: string[] = ['exec', '--json'];

    if (args.model) commandArgs.push('--model', args.model);
    if (args.dangerouslyBypassApprovalsAndSandbox) {
      commandArgs.push('--dangerously-bypass-approvals-and-sandbox');
    } else if (args.sandboxMode) {
      commandArgs.push('--sandbox', args.sandboxMode);
    }
    if (args.workingDirectory) commandArgs.push('--cd', args.workingDirectory);
    if (args.additionalDirectories?.length) {
      for (const dir of args.additionalDirectories) commandArgs.push('--add-dir', dir);
    }
    if (args.skipGitRepoCheck) commandArgs.push('--skip-git-repo-check');
    if (args.modelReasoningEffort) {
      commandArgs.push('--config', `model_reasoning_effort=${JSON.stringify(args.modelReasoningEffort)}`);
    }
    if (args.networkAccessEnabled !== undefined) {
      commandArgs.push('--config', `sandbox_workspace_write.network_access=${args.networkAccessEnabled}`);
    }
    if (args.webSearchEnabled !== undefined) {
      commandArgs.push('--config', `web_search=${JSON.stringify(args.webSearchEnabled ? 'live' : 'disabled')}`);
    }
    if (args.approvalPolicy && !args.dangerouslyBypassApprovalsAndSandbox) {
      commandArgs.push('--config', `approval_policy=${JSON.stringify(args.approvalPolicy)}`);
    }
    if (this.baseUrl) {
      commandArgs.push('--config', `openai_base_url=${JSON.stringify(this.baseUrl)}`);
    }
    if (args.threadId) {
      commandArgs.push('resume', args.threadId);
    }
    for (const image of images) {
      commandArgs.push('--image', image);
    }

    const childEnv = this.env ?? { ...process.env } as Record<string, string>;
    if (this.apiKey) {
      childEnv.CODEX_API_KEY = this.apiKey;
    }
    if (!childEnv.CODEX_INTERNAL_ORIGINATOR_OVERRIDE) {
      childEnv.CODEX_INTERNAL_ORIGINATOR_OVERRIDE = 'claudian';
    }

    const resolvedEnv = this.env ?? { ...process.env } as Record<string, string>;
    const spawnPath = cliPathRequiresNode(this.executablePath)
      ? (findNodeExecutable(resolvedEnv.PATH) || 'node')
      : this.executablePath;
    const spawnArgs = cliPathRequiresNode(this.executablePath)
      ? [this.executablePath, ...commandArgs]
      : commandArgs;

    const child = spawn(spawnPath, spawnArgs, {
      env: childEnv,
      signal: args.signal,
    });

    if (!child.stdin || !child.stdout) {
      child.kill();
      throw new Error('Codex process did not expose stdin/stdout');
    }

    const stderrChunks: Buffer[] = [];
    child.stderr?.on('data', (chunk) => stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))));

    child.stdin.write(prompt);
    child.stdin.end();

    const rl = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });

    let spawnError: unknown = null;
    child.once('error', (error) => {
      spawnError = error;
    });

    const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });

    try {
      for await (const line of rl) {
        yield line;
      }

      if (spawnError) throw spawnError;

      const { code, signal } = await exitPromise;
      if (code !== 0 || signal) {
        const detail = signal ? `signal ${signal}` : `code ${code ?? 1}`;
        const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
        throw new Error(stderr ? `Codex exited with ${detail}: ${stderr}` : `Codex exited with ${detail}`);
      }
    } finally {
      rl.close();
      child.removeAllListeners();
      if (!child.killed) {
        try {
          child.kill();
        } catch {
          // ignore cleanup errors
        }
      }
    }
  }
}

function normalizeInput(input: Input): { prompt: string; images: string[] } {
  if (typeof input === 'string') {
    return { prompt: input, images: [] };
  }

  const promptParts: string[] = [];
  const images: string[] = [];
  for (const item of input) {
    if (item.type === 'text') promptParts.push(item.text);
    if (item.type === 'local_image') images.push(item.path);
  }

  return { prompt: promptParts.join('\n\n'), images };
}

export type CodexOptions = {
  codexPathOverride?: string;
  baseUrl?: string;
  apiKey?: string;
  env?: Record<string, string>;
};

export class Codex {
  private readonly exec: CodexExec;

  constructor(options: CodexOptions = {}) {
    this.exec = new CodexExec(
      options.codexPathOverride || 'codex',
      options.baseUrl,
      options.apiKey,
      options.env,
    );
  }

  startThread(options: ThreadOptions = {}): Thread {
    return new Thread(this.exec, options);
  }

  resumeThread(id: string, options: ThreadOptions = {}): Thread {
    return new Thread(this.exec, options, id);
  }
}
