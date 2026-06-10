import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryResult, MemoryTarget } from "./types.js";

const ENTRY_DELIMITER = "\n§\n";

/**
 * File-backed memory store with frozen-snapshot semantics.
 *
 * Two flat files — MEMORY.md (agent notes) and USER.md (user profile) —
 * each storing entries separated by the § (section sign) delimiter.
 *
 * Mid-session writes go to disk immediately but do NOT affect the system
 * prompt until the next session (frozen snapshot pattern). This keeps the
 * LLM prefix cache valid across all turns in a session.
 */
export class MemoryStore {
	private readonly dir: string;
	private readonly memoryCharLimit: number;
	private readonly userCharLimit: number;

	/** Live entries — updated by tool calls, persisted to disk. */
	memoryEntries: string[] = [];
	userEntries: string[] = [];

	/** Frozen at loadFromDisk() time — injected into system prompt, never mutated mid-session. */
	private _snapshot: Record<MemoryTarget, string> = { memory: "", user: "" };

	constructor(dir: string, memoryCharLimit = 2200, userCharLimit = 1375) {
		this.dir = dir;
		this.memoryCharLimit = memoryCharLimit;
		this.userCharLimit = userCharLimit;
	}

	// ── Lifecycle ──────────────────────────────────────────────────────────

	ensureDir(): void {
		if (!existsSync(this.dir)) {
			mkdirSync(this.dir, { recursive: true });
		}
	}

	/** Load entries from disk and capture the frozen snapshot. */
	loadFromDisk(): void {
		this.ensureDir();
		this.memoryEntries = this._readFile(this._pathFor("memory"));
		this.userEntries = this._readFile(this._pathFor("user"));
		// Deduplicate preserving order
		this.memoryEntries = [...new Set(this.memoryEntries)];
		this.userEntries = [...new Set(this.userEntries)];
		// Capture snapshot — never modified again
		this._snapshot = {
			memory: this._renderBlock("memory", this.memoryEntries),
			user: this._renderBlock("user", this.userEntries),
		};
	}

	// ── System prompt ──────────────────────────────────────────────────────

	/** Return the frozen snapshot block for the given target, or null if empty. */
	formatForSystemPrompt(target: MemoryTarget): string | null {
		const block = this._snapshot[target];
		return block || null;
	}

	// ── Tool operations ────────────────────────────────────────────────────

	add(target: MemoryTarget, content: string): MemoryResult {
		content = content.trim();
		if (!content) return this._err(target, "Content cannot be empty.");

		// Prevent exact duplicates
		const entries = this._entriesFor(target);
		if (entries.includes(content)) {
			return this._ok(target, "Entry already exists (no duplicate added).");
		}

		// Check budget
		const limit = this._limitFor(target);
		const current = this._charCount(target);
		const newTotal = current + (entries.length > 0 ? ENTRY_DELIMITER.length : 0) + content.length;
		if (newTotal > limit) {
			return {
				success: false,
				target,
				message: `Memory at ${current.toLocaleString()}/${limit.toLocaleString()} chars. Remove entries first.`,
				usage: `${Math.round((current / limit) * 100)}% — ${current.toLocaleString()}/${limit.toLocaleString()} chars`,
				entryCount: entries.length,
				entries,
			};
		}

		entries.push(content);
		this._setEntries(target, entries);
		this._writeFile(this._pathFor(target), entries);
		return this._ok(target, "Entry added.");
	}

	replace(target: MemoryTarget, oldText: string, newContent: string): MemoryResult {
		oldText = oldText.trim();
		newContent = newContent.trim();
		if (!oldText) return this._err(target, "old_text cannot be empty.");
		if (!newContent) return this._err(target, "new_content cannot be empty. Use 'remove' to delete.");

		const entries = this._entriesFor(target);
		const matches = entries.map((e, i) => ({ idx: i, entry: e })).filter((m) => m.entry.includes(oldText));

		if (matches.length === 0) {
			return this._err(target, `No entry matched '${oldText}'.`);
		}

		// Multiple different matches → ask for more specificity
		const unique = [...new Set(matches.map((m) => m.entry))];
		if (unique.length > 1) {
			return {
				success: false,
				target,
				message: `Multiple entries matched '${oldText}'. Be more specific.`,
				usage: this._usageStr(target),
				entryCount: entries.length,
				entries: unique.map((e) => e.slice(0, 80) + (e.length > 80 ? "..." : "")),
			};
		}

		// Check budget after replacement
		const idx = matches[0].idx;
		const limit = this._limitFor(target);
		const test = [...entries];
		test[idx] = newContent;
		const newTotal = this._joinLen(test);
		if (newTotal > limit) {
			return this._err(target, `Replacement would exceed the ${limit.toLocaleString()} char limit.`);
		}

		entries[idx] = newContent;
		this._setEntries(target, entries);
		this._writeFile(this._pathFor(target), entries);
		return this._ok(target, "Entry replaced.");
	}

	remove(target: MemoryTarget, oldText: string): MemoryResult {
		oldText = oldText.trim();
		if (!oldText) return this._err(target, "old_text cannot be empty.");

		const entries = this._entriesFor(target);
		const matches = entries.map((e, i) => ({ idx: i, entry: e })).filter((m) => m.entry.includes(oldText));

		if (matches.length === 0) {
			return this._err(target, `No entry matched '${oldText}'.`);
		}

		const unique = [...new Set(matches.map((m) => m.entry))];
		if (unique.length > 1) {
			return {
				success: false,
				target,
				message: `Multiple entries matched '${oldText}'. Be more specific.`,
				usage: this._usageStr(target),
				entryCount: entries.length,
				entries: unique.map((e) => e.slice(0, 80) + (e.length > 80 ? "..." : "")),
			};
		}

		entries.splice(matches[0].idx, 1);
		this._setEntries(target, entries);
		this._writeFile(this._pathFor(target), entries);
		return this._ok(target, "Entry removed.");
	}

	// ── Internal ───────────────────────────────────────────────────────────

	private _entriesFor(target: MemoryTarget): string[] {
		return target === "user" ? this.userEntries : this.memoryEntries;
	}

	private _setEntries(target: MemoryTarget, entries: string[]): void {
		if (target === "user") this.userEntries = entries;
		else this.memoryEntries = entries;
	}

	private _limitFor(target: MemoryTarget): number {
		return target === "user" ? this.userCharLimit : this.memoryCharLimit;
	}

	private _charCount(target: MemoryTarget): number {
		return this._joinLen(this._entriesFor(target));
	}

	private _joinLen(entries: string[]): number {
		return entries.join(ENTRY_DELIMITER).length;
	}

	private _usageStr(target: MemoryTarget): string {
		const current = this._charCount(target);
		const limit = this._limitFor(target);
		const pct = limit > 0 ? Math.min(100, Math.round((current / limit) * 100)) : 0;
		return `${pct}% — ${current.toLocaleString()}/${limit.toLocaleString()} chars`;
	}

	private _ok(target: MemoryTarget, message: string): MemoryResult {
		const entries = this._entriesFor(target);
		return {
			success: true,
			target,
			message,
			usage: this._usageStr(target),
			entryCount: entries.length,
			entries,
		};
	}

	private _err(target: MemoryTarget, message: string): MemoryResult {
		const entries = this._entriesFor(target);
		return {
			success: false,
			target,
			message,
			usage: this._usageStr(target),
			entryCount: entries.length,
			entries,
		};
	}

	private _renderBlock(target: MemoryTarget, entries: string[]): string {
		if (entries.length === 0) return "";
		const limit = this._limitFor(target);
		const content = entries.join(ENTRY_DELIMITER);
		const pct = limit > 0 ? Math.min(100, Math.round((content.length / limit) * 100)) : 0;
		const sep = "═".repeat(46);

		if (target === "user") {
			return `${sep}\nUSER PROFILE (who the user is) [${pct}% — ${content.length.toLocaleString()}/${limit.toLocaleString()} chars]\n${sep}\n${content}`;
		}
		return `${sep}\nMEMORY (your personal notes) [${pct}% — ${content.length.toLocaleString()}/${limit.toLocaleString()} chars]\n${sep}\n${content}`;
	}

	private _pathFor(target: MemoryTarget): string {
		return join(this.dir, target === "user" ? "USER.md" : "MEMORY.md");
	}

	private _readFile(path: string): string[] {
		if (!existsSync(path)) return [];
		try {
			const raw = readFileSync(path, "utf-8").trim();
			if (!raw) return [];
			return raw
				.split(ENTRY_DELIMITER)
				.map((e) => e.trim())
				.filter(Boolean);
		} catch {
			return [];
		}
	}

	/** Synchronous atomic write via temp file + rename. */
	private _writeFile(path: string, entries: string[]): void {
		const content = entries.join(ENTRY_DELIMITER);
		const tmpPath = join(tmpdir(), `.mem_${randomUUID()}.tmp`);
		try {
			writeFileSync(tmpPath, content, "utf-8");
			this.ensureDir();
			renameSync(tmpPath, path);
		} catch (e) {
			try {
				unlinkSync(tmpPath);
			} catch {
				/* ignore cleanup errors */
			}
			throw e;
		}
	}
}
