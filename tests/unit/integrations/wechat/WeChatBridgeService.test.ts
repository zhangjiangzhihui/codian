const mockRequestUrl = jest.fn();

jest.mock('obsidian', () => ({
  requestUrl: (...args: unknown[]) => mockRequestUrl(...args),
}));

import { WECHAT_MESSAGE_ITEM_TYPE, WECHAT_MESSAGE_STATE, WECHAT_MESSAGE_TYPE, type WeChatMessage } from '@/integrations/wechat/types';
import { WeChatBridgeService } from '@/integrations/wechat/WeChatBridgeService';

describe('WeChatBridgeService', () => {
  function createService() {
    const plugin = {
      manifest: {
        version: '1.3.72',
      },
      settings: {
        wechat: {
          enabled: true,
          baseUrl: 'https://ilinkai.weixin.qq.com',
          cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c',
          botToken: 'token',
          accountId: '',
          routeTag: '',
          allowedUserIds: [],
          pollTimeoutSeconds: 35,
          syncCursor: '',
          chatConversationMap: {},
          openClawStateDir: '',
        },
        telegram: {
          chatConversationMap: {},
        },
        persistentExternalContextPaths: [],
      },
      saveSettings: jest.fn().mockResolvedValue(undefined),
      getConversationById: jest.fn().mockResolvedValue(null),
      createConversation: jest.fn(),
      updateConversation: jest.fn(),
      findConversationAcrossViews: jest.fn().mockReturnValue(null),
      getView: jest.fn().mockReturnValue(null),
      mcpManager: {},
    } as any;

    return {
      plugin,
      service: new WeChatBridgeService(plugin),
    };
  }

  function mockRequestJson(body: unknown, status = 200) {
    mockRequestUrl.mockResolvedValueOnce({
      status,
      text: JSON.stringify(body),
    });
  }

  beforeEach(() => {
    jest.restoreAllMocks();
    mockRequestUrl.mockReset();
  });

  it('extracts text from text items and voice transcripts', () => {
    const { service } = createService();
    const instance = service as any;

    expect(instance.extractMessageText([
      { type: WECHAT_MESSAGE_ITEM_TYPE.TEXT, text_item: { text: ' hello ' } },
    ])).toBe('hello');
    expect(instance.extractMessageText([
      { type: WECHAT_MESSAGE_ITEM_TYPE.VOICE, voice_item: { text: ' spoken text ' } },
    ])).toBe('spoken text');
  });

  it('builds fallback notes for unsupported WeChat media', () => {
    const { service } = createService();
    const instance = service as any;

    const hints = instance.collectUnsupportedMediaHints([
      { type: WECHAT_MESSAGE_ITEM_TYPE.FILE },
      { type: WECHAT_MESSAGE_ITEM_TYPE.VOICE, voice_item: {} },
    ]);
    const prompt = instance.buildExecutionPrompt('check this', 0, hints);

    expect(hints).toEqual([
      'WeChat file received, but Codian cannot inspect arbitrary file attachments through this bridge yet.',
      'WeChat voice message received, but Codian cannot transcribe raw voice through this bridge yet.',
    ]);
    expect(prompt).toBe(
      'WeChat file received, but Codian cannot inspect arbitrary file attachments through this bridge yet.\n\n'
      + 'WeChat voice message received, but Codian cannot transcribe raw voice through this bridge yet.\n\n'
      + 'check this',
    );
  });

  it('replies immediately when a message only contains unsupported media', async () => {
    const { service } = createService();
    const instance = service as any;
    const safeReplySpy = jest.spyOn(instance, 'safeReply').mockResolvedValue(undefined);
    jest.spyOn(instance, 'startTypingSession').mockResolvedValue(async () => {});

    const message: WeChatMessage = {
      from_user_id: 'wxid_user@im.wechat',
      context_token: 'ctx-1',
      message_type: WECHAT_MESSAGE_TYPE.USER,
      message_state: WECHAT_MESSAGE_STATE.FINISH,
      item_list: [
        { type: WECHAT_MESSAGE_ITEM_TYPE.FILE },
      ],
    };

    await instance.handleMessage(message);

    expect(safeReplySpy).toHaveBeenCalledWith(
      'wxid_user@im.wechat',
      'ctx-1',
      'This WeChat bridge currently supports text and image messages. Keep using Telegram for files, raw voice, and video.',
    );
  });

  it('starts QR login and saves confirmed credentials into settings', async () => {
    const { service, plugin } = createService();

    mockRequestJson({
      qrcode: 'qr-1',
      qrcode_img_content: 'https://example.com/qr-1.png',
    });
    mockRequestJson({
      status: 'confirmed',
      bot_token: 'wechat-token',
      ilink_bot_id: 'wechat-account',
      baseurl: 'https://wechat-gateway.example.com',
      ilink_user_id: 'wxid_login@im.wechat',
    });

    const started = await service.startQrLogin();
    const polled = await service.pollQrLogin(started.sessionKey ?? '');

    expect(started.active).toBe(true);
    expect(started.status).toBe('waiting');
    expect(polled.connected).toBe(true);
    expect(polled.configUpdated).toBe(true);
    expect(polled.status).toBe('confirmed');
    expect(plugin.settings.wechat.enabled).toBe(true);
    expect(plugin.settings.wechat.botToken).toBe('wechat-token');
    expect(plugin.settings.wechat.accountId).toBe('wechat-account');
    expect(plugin.settings.wechat.baseUrl).toBe('https://wechat-gateway.example.com');
    expect(plugin.settings.wechat.syncCursor).toBe('');
    expect(plugin.saveSettings).toHaveBeenCalled();
  });

  it('switches QR status polling to the redirected host', async () => {
    const { service } = createService();

    mockRequestJson({
      qrcode: 'qr-redirect',
      qrcode_img_content: 'https://example.com/qr-redirect.png',
    });
    mockRequestJson({
      status: 'scaned_but_redirect',
      redirect_host: 'redirect.wechat.example.com',
    });
    mockRequestJson({
      status: 'wait',
    });

    const started = await service.startQrLogin();
    const sessionKey = started.sessionKey ?? '';
    const redirected = await service.pollQrLogin(sessionKey);
    const waiting = await service.pollQrLogin(sessionKey);

    expect(redirected.status).toBe('scanned');
    expect(waiting.status).toBe('waiting');
    expect(String(mockRequestUrl.mock.calls[2]?.[0]?.url ?? '')).toContain('https://redirect.wechat.example.com/ilink/bot/get_qrcode_status');
  });

  it('refreshes the QR code when the upstream marks it expired', async () => {
    const { service } = createService();

    mockRequestJson({
      qrcode: 'qr-old',
      qrcode_img_content: 'https://example.com/qr-old.png',
    });
    mockRequestJson({
      status: 'expired',
    });
    mockRequestJson({
      qrcode: 'qr-new',
      qrcode_img_content: 'https://example.com/qr-new.png',
    });

    const started = await service.startQrLogin();
    const refreshed = await service.pollQrLogin(started.sessionKey ?? '');

    expect(refreshed.active).toBe(true);
    expect(refreshed.status).toBe('waiting');
    expect(refreshed.qrCodeUrl).toBe('https://example.com/qr-new.png');
    expect(refreshed.message).toContain('fresh QR code');
  });
});
