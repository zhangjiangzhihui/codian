import { CodexService } from '@/core/agent/CodexService';
import type ClaudianPlugin from '@/main';

describe('CodexService', () => {
  async function collectChunks(gen: AsyncGenerator<any>): Promise<any[]> {
    const chunks: any[] = [];
    for await (const chunk of gen) {
      chunks.push(chunk);
    }
    return chunks;
  }

  function createEventStream(events: any[]) {
    return {
      events: (async function* () {
        for (const event of events) {
          yield event;
        }
      })(),
    };
  }

  it('continues in the current thread after plan approval', async () => {
    const startThread = {
      id: null,
      runStreamed: jest.fn().mockResolvedValue(createEventStream([
        { type: 'thread.started', thread_id: 'thread-1' },
        { type: 'item.completed', item: { id: 'plan-msg', type: 'agent_message', text: 'Plan step 1\nPlan step 2' } },
        { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 2 } },
      ])),
    };

    const resumedThread = {
      id: 'thread-1',
      runStreamed: jest.fn().mockResolvedValue(createEventStream([
        { type: 'item.completed', item: { id: 'impl-msg', type: 'agent_message', text: 'Implemented the approved plan.' } },
        { type: 'turn.completed', usage: { input_tokens: 2, cached_input_tokens: 0, output_tokens: 3 } },
      ])),
    };

    const startThreadMock = jest.fn(() => startThread);
    const resumeThreadMock = jest.fn(() => resumedThread);

    const mockPlugin = {
      app: { vault: { adapter: { basePath: '/mock/vault/path' } } },
      settings: {
        agentProvider: 'codex',
        permissionMode: 'plan',
        model: 'gpt-5-codex',
        effortLevel: 'high',
        systemPrompt: '',
        codexCliPath: '',
        userName: '',
        customContextLimits: {},
      },
      getActiveEnvironmentVariables: jest.fn().mockReturnValue(''),
      getResolvedCodexCliPath: jest.fn().mockReturnValue('/mock/codex'),
    } as unknown as ClaudianPlugin;

    const service = new CodexService(mockPlugin, {} as any);
    (service as any).codex = {
      startThread: startThreadMock,
      resumeThread: resumeThreadMock,
    };

    const exitPlanModeCallback = jest.fn().mockImplementation(async (input: Record<string, unknown>) => {
      expect(input).toEqual({ planContent: 'Plan step 1\nPlan step 2' });
      (mockPlugin.settings as any).permissionMode = 'yolo';
      return { type: 'approve' as const };
    });
    service.setExitPlanModeCallback(exitPlanModeCallback);

    const chunks = await collectChunks(service.query('Create a plan'));

    expect(exitPlanModeCallback).toHaveBeenCalledTimes(1);
    expect(resumeThreadMock).toHaveBeenCalledWith('thread-1', expect.objectContaining({
      dangerouslyBypassApprovalsAndSandbox: true,
    }));
    expect(resumedThread.runStreamed).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'text',
          text: expect.stringContaining('The user approved the plan.'),
        }),
      ]),
      expect.any(Object),
    );
    expect(chunks.some((chunk) => chunk.type === 'text' && chunk.content.includes('Plan step 1'))).toBe(true);
    expect(chunks.some((chunk) => chunk.type === 'text' && chunk.content.includes('Implemented the approved plan.'))).toBe(true);
    expect(chunks[chunks.length - 1]).toEqual({ type: 'done' });
  });

  it('uses provider-aware system prompt and richer recovered history for first turn', async () => {
    const thread = {
      id: null,
      runStreamed: jest.fn().mockResolvedValue(createEventStream([
        { type: 'thread.started', thread_id: 'thread-2' },
        { type: 'item.completed', item: { id: 'msg', type: 'agent_message', text: '你好，我是 Codex。' } },
        { type: 'turn.completed', usage: { input_tokens: 2, cached_input_tokens: 0, output_tokens: 3 } },
      ])),
    };

    const mockPlugin = {
      app: { vault: { adapter: { basePath: '/mock/vault/path' } } },
      settings: {
        agentProvider: 'codex',
        permissionMode: 'normal',
        model: 'gpt-5.4',
        effortLevel: 'high',
        systemPrompt: '',
        codexCliPath: '',
        userName: '张晓秋',
        customContextLimits: {},
      },
      getActiveEnvironmentVariables: jest.fn().mockReturnValue(''),
      getResolvedCodexCliPath: jest.fn().mockReturnValue('/mock/codex'),
    } as unknown as ClaudianPlugin;

    const service = new CodexService(mockPlugin, {} as any);
    (service as any).codex = {
      startThread: jest.fn(() => thread),
      resumeThread: jest.fn(),
    };

    const previousMessages = [
      {
        id: 'u1',
        role: 'user',
        content: '请介绍一下你自己',
        timestamp: Date.now() - 2000,
      },
      {
        id: 'a1',
        role: 'assistant',
        content: '我之前回答过。',
        timestamp: Date.now() - 1000,
      },
    ];

    await collectChunks(service.query('你现在是谁？', undefined, previousMessages as any));

    const firstCallInput = thread.runStreamed.mock.calls[0][0];
    expect(firstCallInput[0].text).toContain('You are Codex');
    expect(firstCallInput[0].text).not.toContain('You are Codex running inside the Claudian Obsidian plugin.');
    expect(firstCallInput[0].text).toContain('The user\'s preferred name is 张晓秋.');
    expect(firstCallInput[0].text).toContain('User: 请介绍一下你自己');
    expect(firstCallInput[0].text).toContain('Assistant: 我之前回答过。');
    expect(firstCallInput[0].text).toContain('User: 你现在是谁？');
  });
});
