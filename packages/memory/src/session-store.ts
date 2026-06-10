import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import type { SessionMessage, SessionMeta, SessionSearchOptions, SessionSearchResult } from "./types.js";

// ── Jieba loader (shared with search-index.ts) ──────────────────────────────

const _require = createRequire(import.meta.url);

interface JiebaInstance {
	cutForSearch(sentence: string, hmm: boolean): string[];
}

const { Jieba } = _require("@node-rs/jieba") as {
	Jieba: { withDict(dict: Uint8Array): JiebaInstance };
};
const { dict } = _require("@node-rs/jieba/dict") as { dict: Uint8Array };
const jieba = Jieba.withDict(dict);

// ── Helpers ─────────────────────────────────────────────────────────────────

function preprocessForFts(text: string): string {
	return jieba
		.cutForSearch(text, true)
		.filter((t) => t.trim().length > 0)
		.join(" ");
}

function buildFtsQuery(raw: string): string | null {
	const tokens = jieba
		.cutForSearch(raw.trim(), true)
		.map((t) => t.trim())
		.filter((t) => t.length > 0 && /[\p{L}\p{N}]/u.test(t));
	if (tokens.length === 0) return null;
	return tokens.map((t) => `"${t.replaceAll('"', "")}"`).join(" OR ");
}

function bm25ToScore(rank: number): number {
	if (!Number.isFinite(rank)) return 0;
	const r = Math.max(0, -rank);
	return r / (1 + r);
}

const CJK_RE = /([\u4e00-\u9fff\u3400-\u4dbf])\s+(?=[\u4e00-\u9fff\u3400-\u4dbf])/g;

/** Remove spaces between CJK characters from FTS5 snippet (Jieba artifact). */
function cleanSnippet(s: string): string {
	return s.replace(CJK_RE, "$1");
}

function ensureSchema(db: DatabaseSync): void {
	db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id            TEXT PRIMARY KEY,
      source        TEXT NOT NULL DEFAULT 'cli',
      model         TEXT NOT NULL DEFAULT '',
      user_id       TEXT NOT NULL DEFAULT '',
      project_id    TEXT NOT NULL DEFAULT '',
      started_at    REAL NOT NULL,
      last_active   REAL NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
  `);

	// Migrate: add columns for existing DBs
	for (const col of ["user_id", "project_id"]) {
		try {
			db.exec(`ALTER TABLE sessions ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`);
		} catch {
			/* exists */
		}
	}
	try {
		db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)");
	} catch {
		/* ignore */
	}
	try {
		db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id)");
	} catch {
		/* ignore */
	}

	// Messages table
	db.exec(`
    CREATE TABLE IF NOT EXISTS session_messages (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      role       TEXT NOT NULL,
      content    TEXT NOT NULL DEFAULT '',
      tool_name  TEXT,
      timestamp  REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sm_session ON session_messages(session_id, timestamp);
  `);

	// FTS5 virtual table — external content, Jieba-segmented on insert
	db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS session_messages_fts USING fts5(
      content,
      session_id UNINDEXED,
      role       UNINDEXED
    );
  `);
}

// ── SessionStore ────────────────────────────────────────────────────────────

export class SessionStore {
	private readonly db: DatabaseSync;

	constructor(dbPath: string) {
		this.db = new DatabaseSync(dbPath);
		this.db.exec("PRAGMA journal_mode=WAL");
		ensureSchema(this.db);
	}

	// ── Write ──────────────────────────────────────────────────────────────

	insertMessage(msg: SessionMessage): void {
		const ftsText = preprocessForFts(msg.content);
		this.db
			.prepare(
				`INSERT INTO session_messages_fts(content, session_id, role)
         VALUES (?, ?, ?)`,
			)
			.run(ftsText, msg.sessionId, msg.role);
		const result = this.db
			.prepare(
				`INSERT INTO session_messages(session_id, role, content, tool_name, timestamp)
         VALUES (?, ?, ?, ?, ?)`,
			)
			.run(msg.sessionId, msg.role, msg.content, msg.toolName ?? null, msg.timestamp);
		msg.id = Number(result.lastInsertRowid);
	}

	insertMessages(msgs: SessionMessage[]): void {
		const insertFts = this.db.prepare("INSERT INTO session_messages_fts(content, session_id, role) VALUES (?, ?, ?)");
		const insertMsg = this.db.prepare(
			"INSERT INTO session_messages(session_id, role, content, tool_name, timestamp) VALUES (?, ?, ?, ?, ?)",
		);
		for (const msg of msgs) {
			insertFts.run(preprocessForFts(msg.content), msg.sessionId, msg.role);
			const r = insertMsg.run(msg.sessionId, msg.role, msg.content, msg.toolName ?? null, msg.timestamp);
			msg.id = Number(r.lastInsertRowid);
		}
	}

	upsertSession(session: {
		id: string;
		source?: string;
		model?: string;
		userId?: string;
		projectId?: string;
		startedAt: number;
		lastActive: number;
		messageCount: number;
	}): void {
		this.db
			.prepare(
				`INSERT INTO sessions(id, source, model, user_id, project_id, started_at, last_active, message_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           last_active   = excluded.last_active,
           message_count = sessions.message_count + excluded.message_count`,
			)
			.run(
				session.id,
				session.source ?? "cli",
				session.model ?? "",
				session.userId ?? "",
				session.projectId ?? "",
				session.startedAt,
				session.lastActive,
				session.messageCount,
			);
	}

	// ── Read ──────────────────────────────────────────────────────────────

	getMessages(sessionId: string): SessionMessage[] {
		const rows = this.db
			.prepare(
				"SELECT id, session_id AS sessionId, role, content, tool_name AS toolName, timestamp FROM session_messages WHERE session_id = ? ORDER BY timestamp, id",
			)
			.all(sessionId) as unknown as SessionMessage[];
		return rows;
	}

	listSessions(opts?: { limit?: number; offset?: number }): SessionMeta[] {
		const limit = opts?.limit ?? 20;
		const offset = opts?.offset ?? 0;
		return this.db
			.prepare(
				`SELECT id, source, model, started_at AS startedAt, last_active AS lastActive,
              message_count AS messageCount,
              COALESCE(
                (SELECT substr(content, 1, 200) FROM session_messages
                 WHERE session_id = sessions.id AND role = 'user'
                 ORDER BY timestamp ASC LIMIT 1),
                ''
              ) AS preview
       FROM sessions
       ORDER BY last_active DESC
       LIMIT ? OFFSET ?`,
			)
			.all(limit, offset) as unknown as SessionMeta[];
	}

	// ── Search ────────────────────────────────────────────────────────────

	search(opts: SessionSearchOptions): SessionSearchResult[] {
		const limit = Math.min(opts.maxResults ?? 3, 5);

		// Empty query → list recent sessions (no LLM cost)
		if (!opts.query || !opts.query.trim()) {
			return this.listSessions({ limit }).map((s) => ({
				sessionId: s.id,
				title: s.preview.slice(0, 80) || s.id.slice(0, 8),
				source: s.source,
				startedAt: new Date(s.startedAt * 1000).toISOString(),
				model: s.model,
				snippet: s.preview,
				score: 0,
			}));
		}

		// FTS5 search with Jieba tokenisation
		const ftsQuery = buildFtsQuery(opts.query);
		if (!ftsQuery) return [];

		const where: string[] = ["session_messages_fts MATCH ?"];
		const params: unknown[] = [ftsQuery];

		if (opts.from) {
			const fromTs = new Date(opts.from).getTime() / 1000;
			if (!Number.isNaN(fromTs)) {
				where.push("s.last_active >= ?");
				params.push(fromTs);
			}
		}

		if (opts.to) {
			const toTs = new Date(opts.to).getTime() / 1000;
			if (!Number.isNaN(toTs)) {
				where.push("s.last_active <= ?");
				params.push(toTs);
			}
		}

		if (opts.roleFilter) {
			const roles = opts.roleFilter
				.split(",")
				.map((r) => r.trim())
				.filter(Boolean);
			if (roles.length > 0) {
				where.push(`role IN (${roles.map(() => "?").join(",")})`);
				params.push(...roles);
			}
		}

		const sql = `
      SELECT s.id AS sessionId, s.source, s.model, s.started_at AS startedAt,
             snippet(session_messages_fts, 0, '>>>', '<<<', '...', 40) AS snippet,
             bm25(session_messages_fts) AS rank
      FROM session_messages_fts
      JOIN sessions s ON session_messages_fts.session_id = s.id
      WHERE ${where.join(" AND ")}
      ORDER BY rank ASC
      LIMIT 60
    `;

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const rows = this.db.prepare(sql).all(...(params as any)) as unknown as {
			sessionId: string;
			source: string;
			model: string;
			startedAt: number;
			snippet: string;
			rank: number;
		}[];

		// Deduplicate by session, take top N
		const seen = new Set<string>();
		const results: SessionSearchResult[] = [];
		for (const row of rows) {
			if (seen.has(row.sessionId)) continue;
			seen.add(row.sessionId);
			results.push({
				sessionId: row.sessionId,
				title: cleanSnippet(row.snippet.replace(/>>>|<<</g, "")).slice(0, 80),
				source: row.source,
				startedAt: new Date(row.startedAt * 1000).toISOString(),
				model: row.model,
				snippet: cleanSnippet(row.snippet),
				score: bm25ToScore(row.rank),
			});
			if (results.length >= limit) break;
		}

		return results;
	}

	close(): void {
		this.db.close();
	}
}
