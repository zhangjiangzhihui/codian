const mockRequestUrl = jest.fn();

jest.mock('obsidian', () => ({
  requestUrl: (...args: unknown[]) => mockRequestUrl(...args),
}));

import { createCipheriv } from 'node:crypto';

import { downloadWeChatImagesFromMessage } from '@/integrations/wechat/media';

describe('wechat media', () => {
  afterEach(() => {
    mockRequestUrl.mockReset();
    jest.restoreAllMocks();
  });

  it('downloads and decrypts an encrypted WeChat image', async () => {
    const plaintext = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
    const cipher = createCipheriv('aes-128-ecb', key, null);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);

    mockRequestUrl.mockResolvedValue({
      status: 200,
      arrayBuffer: encrypted.buffer.slice(encrypted.byteOffset, encrypted.byteOffset + encrypted.byteLength),
    });

    const images = await downloadWeChatImagesFromMessage({
      message_id: 42,
      item_list: [
        {
          type: 2,
          msg_id: 'item-1',
          image_item: {
            aeskey: key.toString('hex'),
            media: {
              full_url: 'https://cdn.example.com/image.bin',
            },
            thumb_width: 320,
            thumb_height: 240,
          },
        },
      ],
    });

    expect(images).toEqual([expect.objectContaining({
      id: 'wechat-img-42-item-1',
      name: 'wechat-item-1.png',
      mediaType: 'image/png',
      data: plaintext.toString('base64'),
      size: plaintext.length,
      width: 320,
      height: 240,
    })]);
  });

  it('downloads a quoted image from the CDN fallback URL', async () => {
    const plaintext = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 1, 2, 3]);
    mockRequestUrl.mockResolvedValue({
      status: 200,
      arrayBuffer: plaintext.buffer.slice(plaintext.byteOffset, plaintext.byteOffset + plaintext.byteLength),
    });

    const images = await downloadWeChatImagesFromMessage({
      message_id: 77,
      item_list: [
        {
          type: 1,
          text_item: { text: 'look at this' },
          ref_msg: {
            message_item: {
              type: 2,
              msg_id: 'quoted-image',
              image_item: {
                media: {
                  encrypt_query_param: 'abc123',
                },
              },
            },
          },
        },
      ],
    });

    expect(mockRequestUrl).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=abc123',
      method: 'GET',
      throw: false,
    }));
    expect(images[0]).toEqual(expect.objectContaining({
      id: 'wechat-img-77-quoted-image',
      mediaType: 'image/jpeg',
      data: plaintext.toString('base64'),
    }));
  });
});
