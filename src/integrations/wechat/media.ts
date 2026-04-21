import { createDecipheriv } from 'node:crypto';

import { requestUrl } from 'obsidian';

import type { ImageAttachment, ImageMediaType } from '../../core/types';
import { DEFAULT_WECHAT_CDN_BASE_URL } from './openClawAccount';
import type { WeChatCdnMedia, WeChatImageItem, WeChatMessage, WeChatMessageItem } from './types';
import { WECHAT_MESSAGE_ITEM_TYPE } from './types';

type ImageCandidate = {
  image: WeChatImageItem;
  itemId: string;
};

function buildCdnDownloadUrl(encryptedQueryParam: string, cdnBaseUrl: string): string {
  return `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;
}

function resolveDownloadUrl(media: WeChatCdnMedia | undefined, cdnBaseUrl: string): string {
  const fullUrl = media?.full_url?.trim();
  if (fullUrl) {
    return fullUrl;
  }

  const encryptedQueryParam = media?.encrypt_query_param?.trim();
  if (!encryptedQueryParam) {
    throw new Error('WeChat image is missing both full_url and encrypt_query_param.');
  }

  return buildCdnDownloadUrl(encryptedQueryParam, cdnBaseUrl);
}

function parseMediaAesKey(aesKeyBase64: string): Buffer {
  const decoded = Buffer.from(aesKeyBase64, 'base64');
  if (decoded.length === 16) {
    return decoded;
  }
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii'))) {
    return Buffer.from(decoded.toString('ascii'), 'hex');
  }
  throw new Error(`WeChat aes_key must decode to 16 raw bytes or a 32-char hex string, got ${decoded.length} bytes.`);
}

function resolveImageKey(image: WeChatImageItem): Buffer | null {
  const rawHexKey = image.aeskey?.trim();
  if (rawHexKey) {
    return Buffer.from(rawHexKey, 'hex');
  }

  const mediaKey = image.media?.aes_key?.trim();
  if (!mediaKey) {
    return null;
  }

  return parseMediaAesKey(mediaKey);
}

function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

async function downloadBuffer(url: string, label: string): Promise<Buffer> {
  const response = await requestUrl({
    url,
    method: 'GET',
    throw: false,
  });
  if (response.status >= 400) {
    throw new Error(`${label}: CDN download failed: HTTP ${response.status}`);
  }
  return Buffer.from(response.arrayBuffer);
}

function inferImageMediaType(buffer: Buffer, urlHint?: string): ImageMediaType {
  if (buffer.length >= 8
    && buffer[0] === 0x89
    && buffer[1] === 0x50
    && buffer[2] === 0x4e
    && buffer[3] === 0x47
  ) {
    return 'image/png';
  }
  if (buffer.length >= 3
    && buffer[0] === 0xff
    && buffer[1] === 0xd8
    && buffer[2] === 0xff
  ) {
    return 'image/jpeg';
  }
  if (buffer.length >= 4
    && buffer[0] === 0x47
    && buffer[1] === 0x49
    && buffer[2] === 0x46
    && buffer[3] === 0x38
  ) {
    return 'image/gif';
  }
  if (buffer.length >= 12
    && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    && buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }

  const normalizedUrl = urlHint?.toLowerCase() || '';
  if (normalizedUrl.endsWith('.png')) return 'image/png';
  if (normalizedUrl.endsWith('.gif')) return 'image/gif';
  if (normalizedUrl.endsWith('.webp')) return 'image/webp';
  return 'image/jpeg';
}

function buildImageName(mediaType: ImageMediaType, itemId: string): string {
  const extension = mediaType === 'image/png'
    ? 'png'
    : mediaType === 'image/gif'
      ? 'gif'
      : mediaType === 'image/webp'
        ? 'webp'
        : 'jpg';
  return `wechat-${itemId}.${extension}`;
}

function collectImageCandidates(items?: WeChatMessageItem[], fallbackId?: string): ImageCandidate[] {
  if (!items || items.length === 0) {
    return [];
  }

  const directImages = items
    .map((item, index) => ({
      item,
      index,
    }))
    .filter(({ item }) => item.type === WECHAT_MESSAGE_ITEM_TYPE.IMAGE && item.image_item?.media)
    .map(({ item, index }) => ({
      image: item.image_item!,
      itemId: item.msg_id?.trim() || `${fallbackId ?? 'msg'}-${index}`,
    }));

  if (directImages.length > 0) {
    return directImages;
  }

  return items
    .map((item, index) => ({
      item,
      index,
    }))
    .filter(({ item }) => item.type === WECHAT_MESSAGE_ITEM_TYPE.TEXT && item.ref_msg?.message_item?.type === WECHAT_MESSAGE_ITEM_TYPE.IMAGE)
    .map(({ item, index }) => ({
      image: item.ref_msg!.message_item!.image_item!,
      itemId: item.ref_msg!.message_item!.msg_id?.trim() || `${fallbackId ?? 'ref'}-${index}`,
    }))
    .filter((candidate) => Boolean(candidate.image.media));
}

async function downloadImageAttachment(
  message: WeChatMessage,
  candidate: ImageCandidate,
  cdnBaseUrl: string,
): Promise<ImageAttachment> {
  const url = resolveDownloadUrl(candidate.image.media, cdnBaseUrl);
  const ciphertextOrPlaintext = await downloadBuffer(url, `WeChat image ${candidate.itemId}`);
  const key = resolveImageKey(candidate.image);
  const buffer = key ? decryptAesEcb(ciphertextOrPlaintext, key) : ciphertextOrPlaintext;
  const mediaType = inferImageMediaType(buffer, url);
  const timestamp = message.message_id ?? message.seq ?? message.create_time_ms ?? Date.now();

  return {
    id: `wechat-img-${timestamp}-${candidate.itemId}`,
    name: buildImageName(mediaType, candidate.itemId),
    mediaType,
    data: buffer.toString('base64'),
    size: buffer.length,
    width: candidate.image.thumb_width,
    height: candidate.image.thumb_height,
    source: 'file',
  };
}

export async function downloadWeChatImagesFromMessage(
  message: WeChatMessage,
  cdnBaseUrl = DEFAULT_WECHAT_CDN_BASE_URL,
): Promise<ImageAttachment[]> {
  const fallbackId = String(message.message_id ?? message.seq ?? 'msg');
  const candidates = collectImageCandidates(message.item_list, fallbackId);
  if (candidates.length === 0) {
    return [];
  }

  return await Promise.all(candidates.map((candidate) => downloadImageAttachment(message, candidate, cdnBaseUrl)));
}
