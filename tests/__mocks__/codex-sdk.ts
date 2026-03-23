export class MockThread {
  id: string | null;

  constructor(id: string | null = 'mock-thread-id') {
    this.id = id;
  }

  async run(_input: unknown, _options?: { signal?: AbortSignal }) {
    return {
      items: [],
      finalResponse: '',
      usage: null,
    };
  }

  async runStreamed(_input: unknown, _options?: { signal?: AbortSignal }) {
    async function* events() {
      yield { type: 'thread.started', thread_id: 'mock-thread-id' } as const;
      yield { type: 'turn.completed', usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 } } as const;
    }

    return { events: events() };
  }
}

export class Codex {
  startThread() {
    return new MockThread();
  }

  resumeThread(id: string) {
    return new MockThread(id);
  }
}
