// Protocol types mirroring @tencent-weixin/openclaw-weixin

export const MessageItemType = {
	TEXT: 1,
	IMAGE: 2,
	VOICE: 3,
	FILE: 4,
	VIDEO: 5,
} as const;

export const MessageType = {
	USER: 1,
	BOT: 2,
} as const;

export const MessageState = {
	FINISH: 1,
} as const;

export interface BaseInfo {
	channel_version?: string;
	bot_agent?: string;
}

export interface TextItem {
	text?: string;
}

export interface MessageItem {
	type?: number;
	text_item?: TextItem;
}

export interface WeixinMessage {
	from_user_id?: string;
	to_user_id?: string;
	client_id?: string;
	session_id?: string;
	message_type?: number;
	message_state?: number;
	item_list?: MessageItem[];
	context_token?: string;
}

export interface GetUpdatesResp {
	ret?: number;
	errcode?: number;
	errmsg?: string;
	msgs?: WeixinMessage[];
	get_updates_buf?: string;
	longpolling_timeout_ms?: number;
}

export interface GetConfigResp {
	ret?: number;
	errcode?: number;
	errmsg?: string;
	typing_ticket?: string;
}

/** Account token file stored in accountsDir */
export interface WeixinAccount {
	bot_token: string;
	baseurl: string;
	ilink_bot_id: string;
	ilink_user_id: string;
}
