const mockRequestUrl = jest.fn();

jest.mock('obsidian', () => ({
  requestUrl: (...args: unknown[]) => mockRequestUrl(...args),
}));

import { TelegramBridgeService } from '@/integrations/telegram/TelegramBridgeService';
import type { TelegramMessage, TelegramUpdate } from '@/integrations/telegram/types';

describe('TelegramBridgeService', () => {
  function createService() {
    const plugin = {
      settings: {
        telegram: {
          enabled: true,
          botToken: 'token',
          allowedUserIds: [],
          allowedChatIds: [],
          allowGroupChats: true,
          pollTimeoutSeconds: 30,
          lastUpdateId: 0,
          chatConversationMap: {},
        },
      },
      saveSettings: jest.fn().mockResolvedValue(undefined),
    } as any;

    return new TelegramBridgeService(plugin);
  }

  beforeEach(() => {
    jest.restoreAllMocks();
    mockRequestUrl.mockReset();
  });

  it('extracts the largest Telegram photo attachment', async () => {
    const service = createService() as any;
    jest.spyOn(service, 'fetchTelegramFile').mockResolvedValue({
      file_id: 'photo-large',
      file_unique_id: 'photo-large-uniq',
      file_path: 'photos/image.png',
    });
    mockRequestUrl.mockResolvedValue({
      status: 200,
      arrayBuffer: Uint8Array.from([1, 2, 3]).buffer,
    });

    const message: TelegramMessage = {
      message_id: 7,
      date: 1,
      chat: { id: 1, type: 'private' },
      photo: [
        { file_id: 'photo-small', file_unique_id: 'small', width: 32, height: 32, file_size: 10 },
        { file_id: 'photo-large', file_unique_id: 'large', width: 256, height: 256, file_size: 100 },
      ],
    };

    const images = await service.extractTelegramImages(message);

    expect(images).toEqual([expect.objectContaining({
      id: 'telegram-img-7-large',
      name: 'image.png',
      mediaType: 'image/png',
      width: 256,
      height: 256,
      source: 'file',
    })]);
  });

  it('extracts image documents sent through Telegram as files', async () => {
    const service = createService() as any;
    jest.spyOn(service, 'fetchTelegramFile').mockResolvedValue({
      file_id: 'doc-1',
      file_unique_id: 'doc-uniq',
      file_path: 'documents/original.webp',
    });
    mockRequestUrl.mockResolvedValue({
      status: 200,
      arrayBuffer: Uint8Array.from([9, 8, 7, 6]).buffer,
    });

    const message: TelegramMessage = {
      message_id: 9,
      date: 1,
      chat: { id: 1, type: 'private' },
      document: {
        file_id: 'doc-1',
        file_unique_id: 'doc-uniq',
        file_name: 'original.webp',
        mime_type: 'image/webp',
        width: 800,
        height: 600,
      },
    };

    const images = await service.extractTelegramImages(message);

    expect(images).toEqual([expect.objectContaining({
      id: 'telegram-img-9-doc-uniq',
      name: 'original.webp',
      mediaType: 'image/webp',
      width: 800,
      height: 600,
      source: 'file',
    })]);
  });

  it('ignores non-image documents', async () => {
    const service = createService() as any;
    const fetchTelegramFileSpy = jest.spyOn(service, 'fetchTelegramFile');

    const message: TelegramMessage = {
      message_id: 10,
      date: 1,
      chat: { id: 1, type: 'private' },
      document: {
        file_id: 'doc-pdf',
        file_unique_id: 'doc-pdf-uniq',
        file_name: 'spec.pdf',
        mime_type: 'application/pdf',
      },
    };

    const images = await service.extractTelegramImages(message);

    expect(images).toEqual([]);
    expect(fetchTelegramFileSpy).not.toHaveBeenCalled();
  });

  it('groups Telegram media albums into a single batch', () => {
    const service = createService() as any;

    const updates: TelegramUpdate[] = [
      {
        update_id: 101,
        message: {
          message_id: 1,
          date: 1,
          media_group_id: 'album-1',
          chat: { id: 1, type: 'private' },
          caption: 'album caption',
        },
      },
      {
        update_id: 102,
        message: {
          message_id: 2,
          date: 1,
          media_group_id: 'album-1',
          chat: { id: 1, type: 'private' },
        },
      },
      {
        update_id: 103,
        message: {
          message_id: 3,
          date: 1,
          chat: { id: 1, type: 'private' },
          text: 'single',
        },
      },
    ];

    const batches = service.collectMessageBatches(updates);

    expect(batches).toHaveLength(2);
    expect(batches[0].lastUpdateId).toBe(102);
    expect(batches[0].messages.map((message: TelegramMessage) => message.message_id)).toEqual([1, 2]);
    expect(service.extractBatchText(batches[0].messages)).toBe('album caption');
    expect(batches[1].messages.map((message: TelegramMessage) => message.message_id)).toEqual([3]);
  });

  it('builds a clearer prompt for Telegram albums', () => {
    const service = createService() as any;
    const messages: TelegramMessage[] = [
      {
        message_id: 1,
        date: 1,
        media_group_id: 'album-1',
        chat: { id: 1, type: 'private' },
        caption: 'look at these',
      },
      {
        message_id: 2,
        date: 1,
        media_group_id: 'album-1',
        chat: { id: 1, type: 'private' },
      },
    ];

    const prompt = service.buildExecutionPrompt('look at these', 2, messages, []);

    expect(prompt).toBe('Telegram album with 2 images.\n\nlook at these');
  });

  it('builds fallback notes for unsupported Telegram media', () => {
    const service = createService() as any;
    const messages: TelegramMessage[] = [
      {
        message_id: 4,
        date: 1,
        chat: { id: 1, type: 'private' },
        sticker: {
          file_id: 'sticker-1',
          file_unique_id: 'sticker-uniq',
          width: 512,
          height: 512,
          emoji: '🙂',
        },
      },
      {
        message_id: 5,
        date: 1,
        chat: { id: 1, type: 'private' },
        animation: {
          file_id: 'anim-1',
          file_unique_id: 'anim-uniq',
          width: 320,
          height: 240,
          duration: 2,
        },
      },
    ];

    const hints = service.collectUnsupportedMediaHints(messages);
    const prompt = service.buildExecutionPrompt('', 0, messages, hints);

    expect(hints).toEqual([
      'Telegram sticker received 🙂.',
      'Telegram animation received.',
    ]);
    expect(prompt).toBe('Telegram sticker received 🙂.\n\nTelegram animation received.');
  });

  it('replies with an execution error when media extraction fails', async () => {
    const service = createService() as any;
    jest.spyOn(service, 'extractTelegramImagesFromBatch').mockRejectedValue(new Error('Telegram file download failed: HTTP 404'));
    const safeReplySpy = jest.spyOn(service, 'safeReply').mockResolvedValue(undefined);

    await service.handleMessageBatch({
      lastUpdateId: 201,
      messages: [{
        message_id: 11,
        date: 1,
        chat: { id: 123, type: 'private' },
        photo: [{ file_id: 'photo-1', file_unique_id: 'photo-uniq', width: 64, height: 64 }],
      }],
    });

    expect(safeReplySpy).toHaveBeenCalledWith(123, 'Execution failed:\nTelegram file download failed: HTTP 404');
  });
});
