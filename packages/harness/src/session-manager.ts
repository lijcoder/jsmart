import type { AgentMessage } from "@jsmart/jsmart-agent-core";
import type { Message } from "@jsmart/jsmart-ai";
import { randomUUID } from "crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { createCompactionSummaryMessage } from "./messages.js";

const CURRENT_SESSION_VERSION = 1;

export interface SessionHeader {
	type: "session";
	version?: number;
	id: string;
	timestamp: string;
}

export interface SessionEntryBase {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
}

export interface SessionMessageEntry extends SessionEntryBase {
	type: "message";
	message: AgentMessage;
}

export interface CompactionEntry extends SessionEntryBase {
	type: "compaction";
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
}

export interface ModelChangeEntry extends SessionEntryBase {
	type: "model_change";
	provider: string;
	modelId: string;
}

export interface ThinkingLevelChangeEntry extends SessionEntryBase {
	type: "thinking_level_change";
	thinkingLevel: string;
}

/** Session entry - has id/parentId for tree structure (returned by "read" methods in SessionManager) */
export type SessionEntry = SessionMessageEntry | CompactionEntry | ModelChangeEntry | ThinkingLevelChangeEntry;

/** Raw file entry (includes header) */
export type FileEntry = SessionHeader | SessionEntry;

export interface SessionContext {
	messages: AgentMessage[];
	thinkingLevel: string;
	model: { provider: string; modelId: string } | null;
}

export interface SessionInfo {
	path: string;
	id: string;
	/** Working directory where the session was started. Empty string for old sessions. */
	cwd: string;
	/** User-defined display name from session_info entries. */
	name?: string;
	/** Path to the parent session (if this session was forked). */
	parentSessionPath?: string;
	created: Date;
	modified: Date;
	messageCount: number;
	firstMessage: string;
	allMessagesText: string;
}

export interface NewSessionOptions {
	id?: string;
	parentSession?: string;
}

/** Generate a unique short ID (8 hex chars, collision-checked) */
function generateId(byId: string | null): string {
	if (byId === null) {
		return "0";
	}
	let value = parseInt(byId, 10);
	value = value + 1;
	return value.toString();
}

function loadEntriesFromFile(filePath: string): FileEntry[] {
	if (!existsSync(filePath)) return [];

	const content = readFileSync(filePath, "utf8");
	const entries: FileEntry[] = [];
	const lines = content.trim().split("\n");

	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line) as FileEntry;
			entries.push(entry);
		} catch {
			// Skip malformed lines
		}
	}

	// Validate session header
	if (entries.length === 0) return entries;
	const header = entries[0];
	if (header.type !== "session" || typeof (header as any).id !== "string") {
		return [];
	}

	return entries;
}

export function buildSessionContext(entries: SessionEntry[]): SessionContext {
	let thinkingLevel = "off";
	let model: { provider: string; modelId: string } | null = null;
	let compactionEntry: CompactionEntry | undefined;
	let firstKeptId: string | undefined;

	for (const e of entries) {
		if (e.type === "compaction") {
			// 记录最近的 compaction summary，后续消息从 firstKeptEntryId 开始
			compactionEntry = e;
			firstKeptId = e.firstKeptEntryId;
		} else if (e.type === "thinking_level_change") {
			thinkingLevel = e.thinkingLevel;
		} else if (e.type === "model_change") {
			model = { provider: e.provider, modelId: e.modelId };
		} else if (e.type === "message" && e.message.role === "assistant") {
			model = { provider: e.message.provider, modelId: e.message.model };
		}
	}

	const messages: AgentMessage[] = [];
	let includeMessages = false;
	for (const e of entries) {
		if (e.type === "message") {
			// 如果有 compaction，只从 firstKeptEntryId 开始包含消息
			if (firstKeptId && !includeMessages) {
				if (e.id === firstKeptId) {
					includeMessages = true;
				} else {
					continue;
				}
			}
			if (includeMessages || !firstKeptId) {
				messages.push(e.message);
			}
		}
	}

	// 如果有 compaction summary，作为第一条 user 消息插入（作为上下文提示）
	if (compactionEntry) {
		messages.unshift(
			createCompactionSummaryMessage(
				compactionEntry.summary,
				compactionEntry.tokensBefore,
				compactionEntry.timestamp,
			),
		);
	}

	return { messages, thinkingLevel, model };
}

export class SessionManager {
	private sessionId: string = "";
	private sessionFile: string;
	private leafId: string | null = null;
	private persist: boolean = false;

	constructor(persist: boolean, sessionFile: string) {
		this.persist = persist;
		this.sessionFile = resolve(sessionFile);
		if (this.persist) {
			this.setSessionFile();
		}
	}

	newSession() {
		this.sessionId = randomUUID();
		const timestamp = new Date().toISOString();
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: this.sessionId,
			timestamp,
		};
		this._initFile(header);
		this.leafId = null;
	}

	/** Switch to a different session file (used for resume and branching) */
	setSessionFile(): void {
		if (existsSync(this.sessionFile)) {
			const fileEntries: FileEntry[] = loadEntriesFromFile(this.sessionFile);
			if (fileEntries.length === 0) {
				this.newSession();
				return;
			} else {
				const header = fileEntries.find((e) => e.type === "session") as SessionHeader | undefined;
				this.sessionId = header?.id ?? randomUUID();
				this._buildIndex();
				return;
			}
		} else {
			this.newSession();
		}
	}

	private _buildIndex(): void {
		this.leafId = null;
		const fileEntries: FileEntry[] = loadEntriesFromFile(this.sessionFile);
		for (const entry of fileEntries) {
			if (entry.type === "session") {
				continue;
			}
			this.leafId = entry.id;
		}
	}

	private _initFile(sessionHeader: SessionHeader): void {
		if (!this.persist || !this.sessionFile) return;
		const content = `${JSON.stringify(sessionHeader)}\n`;
		writeFileSync(this.sessionFile, content);
	}

	getSessionId(): string {
		return this.sessionId;
	}

	getSessionFile(): string | undefined {
		return this.sessionFile;
	}

	_persist(entry: SessionEntry): void {
		if (!this.persist || !this.sessionFile) {
			return;
		}
		appendFileSync(this.sessionFile, `${JSON.stringify(entry)}\n`);
	}

	private _appendEntry(entry: SessionEntry): void {
		this.leafId = entry.id;
		this._persist(entry);
	}

	appendMessage(message: Message): string {
		const entry: SessionMessageEntry = {
			type: "message",
			id: generateId(this.leafId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			message,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** Append a compaction summary as child of current leaf, then advance leaf. Returns entry id. */
	appendCompaction(summary: string, firstKeptEntryId: string, tokensBefore: number): string {
		const entry: CompactionEntry = {
			type: "compaction",
			id: generateId(this.leafId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			summary,
			firstKeptEntryId,
			tokensBefore,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	buildSessionContext(): SessionContext {
		if (!(this.persist && this.sessionFile)) {
			return { messages: [], thinkingLevel: "off", model: null };
		}
		return buildSessionContext(this.getEntries());
	}

	/** Get session header */
	getHeader(): SessionHeader {
		const fileEntries: FileEntry[] = loadEntriesFromFile(this.sessionFile);
		const header = fileEntries.find((e) => e.type === "session") as SessionHeader | undefined;
		return header ?? { type: "session", id: this.sessionId, timestamp: new Date().toISOString() };
	}

	/** Get all entries (excluding header) */
	getEntries(): SessionEntry[] {
		const fileEntries: FileEntry[] = loadEntriesFromFile(this.sessionFile);
		return fileEntries.filter((e) => e.type !== "session") as SessionEntry[];
	}

	/** Get the current leaf ID */
	getLeafId(): string | null {
		return this.leafId;
	}

	/** Open an existing session file and return a new SessionManager */
	static open(sessionFile: string): SessionManager {
		const sm = new SessionManager(false, sessionFile);
		sm.setSessionFile();
		return sm;
	}
}
