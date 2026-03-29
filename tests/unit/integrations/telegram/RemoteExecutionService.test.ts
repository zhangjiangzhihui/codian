import type { Conversation, ImageAttachment, StreamChunk } from '@/core/types';
import { RemoteExecutionService } from '@/integrations/telegram/RemoteExecutionService';

const mockApplyForkState = jest.fn();
const mockEnsureReady = jest.fn();
const mockQuery = jest.fn();
const mockGetSessionId = jest.fn();
const mockCleanup = jest.fn();
const mockCancel = jest.fn();

jest.mock('@/core/agent', () => ({
  createAgentService: jest.fn(() => ({
    applyForkState: mockApplyForkState,
    ensureReady: mockEnsureReady,
    query: mockQuery,
    getSessionId: mockGetSessionId,
    cleanup: mockCleanup,
    cancel: mockCancel,
  })),
}));

async function* toAsyncChunks(chunks: StreamChunk[]): AsyncGenerator<StreamChunk> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

describe('RemoteExecutionService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockApplyForkState.mockReturnValue(null);
    mockEnsureReady.mockResolvedValue(true);
    mockGetSessionId.mockReturnValue('sdk-session-1');
    mockQuery.mockImplementation((_prompt, _images, _previousMessages, _options) => toAsyncChunks([]));
  });

  it('persists Telegram images into the local conversation for background executions', async () => {
    const conversation: Conversation = {
      id: 'conv-1',
      title: 'Conversation',
      createdAt: 1,
      updatedAt: 1,
      sessionId: 'conv-1',
      sdkSessionId: 'conv-1',
      isNative: true,
      sdkMessagesLoaded: false,
      messages: [],
    };
    const updateConversation = jest.fn().mockResolvedValue(undefined);
    const getConversationById = jest.fn().mockResolvedValue(conversation);

    const plugin = {
      settings: {
        telegram: {
          chatConversationMap: { chat1: 'conv-1' },
        },
        persistentExternalContextPaths: [],
      },
      mcpManager: {},
      getConversationById,
      createConversation: jest.fn(),
      updateConversation,
      saveSettings: jest.fn().mockResolvedValue(undefined),
      findConversationAcrossViews: jest.fn().mockReturnValue(null),
      getView: jest.fn().mockReturnValue(null),
    } as any;

    const images: ImageAttachment[] = [{
      id: 'img-1',
      name: 'telegram.png',
      mediaType: 'image/png',
      data: 'YmFzZTY0',
      size: 8,
      source: 'file',
      width: 64,
      height: 64,
    }];

    mockQuery.mockImplementation(() => toAsyncChunks([
      { type: 'sdk_user_uuid', uuid: 'user-sdk-1' },
      { type: 'text', content: 'Image received.' },
      { type: 'sdk_assistant_uuid', uuid: 'assistant-sdk-1' },
      { type: 'done' },
    ]));

    const service = new RemoteExecutionService(plugin);
    const result = await service.execute('chat1', '请看这张图', 'conv-1', images);

    expect(result).toEqual({
      conversationId: 'conv-1',
      replyText: 'Image received.',
    });
    expect(updateConversation).toHaveBeenCalledTimes(1);

    const [, updates] = updateConversation.mock.calls[0];
    expect(updates.sessionId).toBe('sdk-session-1');
    expect(updates.sdkSessionId).toBe('sdk-session-1');
    expect(updates.sdkMessagesLoaded).toBe(true);
    expect(updates.messages).toHaveLength(2);
    expect(updates.messages[0]).toMatchObject({
      id: 'user-sdk-1',
      role: 'user',
      content: '请看这张图',
      displayContent: '请看这张图',
      sdkUserUuid: 'user-sdk-1',
    });
    expect(updates.messages[0].images).toEqual(images);
    expect(updates.messages[1]).toMatchObject({
      id: 'assistant-sdk-1',
      role: 'assistant',
      content: 'Image received.',
      sdkAssistantUuid: 'assistant-sdk-1',
    });
  });
});
