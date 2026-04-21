export const WECHAT_MESSAGE_TYPE = {
  USER: 1,
  BOT: 2,
} as const;

export const WECHAT_MESSAGE_STATE = {
  NEW: 0,
  GENERATING: 1,
  FINISH: 2,
} as const;

export const WECHAT_TYPING_STATUS = {
  TYPING: 1,
  CANCEL: 2,
} as const;

export const WECHAT_MESSAGE_ITEM_TYPE = {
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
} as const;

export interface WeChatTextItem {
  text?: string;
}

export interface WeChatVoiceItem {
  text?: string;
  media?: WeChatCdnMedia;
}

export interface WeChatCdnMedia {
  encrypt_query_param?: string;
  aes_key?: string;
  encrypt_type?: number;
  full_url?: string;
}

export interface WeChatImageItem {
  media?: WeChatCdnMedia;
  thumb_media?: WeChatCdnMedia;
  aeskey?: string;
  url?: string;
  mid_size?: number;
  thumb_size?: number;
  thumb_height?: number;
  thumb_width?: number;
  hd_size?: number;
}

export interface WeChatFileItem {
  media?: WeChatCdnMedia;
  file_name?: string;
  md5?: string;
  len?: string;
}

export interface WeChatVideoItem {
  media?: WeChatCdnMedia;
  video_size?: number;
  play_length?: number;
  video_md5?: string;
  thumb_media?: WeChatCdnMedia;
  thumb_size?: number;
  thumb_height?: number;
  thumb_width?: number;
}

export interface WeChatRefMessage {
  message_item?: WeChatMessageItem;
  title?: string;
}

export interface WeChatMessageItem {
  type?: number;
  msg_id?: string;
  ref_msg?: WeChatRefMessage;
  text_item?: WeChatTextItem;
  voice_item?: WeChatVoiceItem;
  image_item?: WeChatImageItem;
  file_item?: WeChatFileItem;
  video_item?: WeChatVideoItem;
}

export interface WeChatMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  session_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: WeChatMessageItem[];
  context_token?: string;
}

export interface WeChatGetUpdatesResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeChatMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

export interface WeChatSendMessageResponse {
  ret?: number;
  errmsg?: string;
}

export interface WeChatGetConfigResponse {
  ret?: number;
  errmsg?: string;
  typing_ticket?: string;
}

export interface WeChatSendTypingResponse {
  ret?: number;
  errmsg?: string;
}
