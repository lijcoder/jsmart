import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Memory, MemoryIndexEntry, MemoryOperation, MemoryType } from "./types.js";

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;
const INDEX_FILENAME = "MEMORY.md";

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } | null {
	const m = raw.match(FRONTMATTER_RE);
	if (!m) return null;
	const meta: Record<string, string> = {};
	for (const line of m[1].split("\n")) {
		const idx = line.indexOf(":");
		if (idx < 0) continue;
		meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
	}
	return { meta, body: m[2] };
}

function serializeMemory(mem: Memory): string {
	return [
		"---",
		`name: ${mem.name}`,
		`description: ${mem.description}`,
		`type: ${mem.type}`,
		`created: ${mem.created}`,
		`updated: ${mem.updated}`,
		"---",
		"",
		mem.content.trim(),
		"",
	].join("\n");
}

/** File-based CRUD store for memory entries. Internal use only. */
export class MemoryStore {
	readonly dir: string;

	constructor(dir: string) {
		this.dir = dir;
	}

	ensureDir(): void {
		if (!existsSync(this.dir)) {
			mkdirSync(this.dir, { recursive: true });
		}
	}

	write(mem: Memory): void {
		this.ensureDir();
		writeFileSync(join(this.dir, `${mem.name}.md`), serializeMemory(mem), "utf-8");
		this._updateIndex(mem.name, mem.description);
	}

	read(name: string): Memory | null {
		const file = join(this.dir, `${name}.md`);
		if (!existsSync(file)) return null;
		const parsed = parseFrontmatter(readFileSync(file, "utf-8"));
		if (!parsed) return null;
		return {
			name: parsed.meta.name ?? name,
			description: parsed.meta.description ?? "",
			type: (parsed.meta.type as MemoryType) ?? "project",
			content: parsed.body.trim(),
			created: parsed.meta.created ?? "",
			updated: parsed.meta.updated ?? "",
		};
	}

	readAll(): Memory[] {
		if (!existsSync(this.dir)) return [];
		return readdirSync(this.dir)
			.filter((f) => f.endsWith(".md") && f !== INDEX_FILENAME)
			.map((f) => this.read(f.slice(0, -3)))
			.filter((m): m is Memory => m !== null);
	}

	listIndex(): MemoryIndexEntry[] {
		const indexFile = join(this.dir, INDEX_FILENAME);
		if (!existsSync(indexFile)) return [];
		const entries: MemoryIndexEntry[] = [];
		for (const line of readFileSync(indexFile, "utf-8").split("\n")) {
			// Match: - [name](file.md) — description
			const m = line.match(/^- \[([^\]]+)\]\(([^)]+)\)\s*[—-]\s*(.+)/);
			if (m) {
				entries.push({ name: m[1], file: m[2], description: m[3].trim() });
			}
		}
		return entries;
	}

	delete(name: string): boolean {
		const file = join(this.dir, `${name}.md`);
		if (!existsSync(file)) return false;
		unlinkSync(file);
		this._removeFromIndex(name);
		return true;
	}

	applyOperations(ops: MemoryOperation[], now: string): void {
		for (const op of ops) {
			if (op.op === "skip") continue;
			if (op.op === "create") {
				this.write({
					name: op.name,
					description: op.description,
					type: op.type,
					content: op.content,
					created: now,
					updated: now,
				});
			} else if (op.op === "update") {
				const existing = this.read(op.name);
				if (existing) {
					this.write({
						...existing,
						description: op.description ?? existing.description,
						content: op.content,
						updated: now,
					});
				}
			} else if (op.op === "delete") {
				this.delete(op.name);
			}
		}
	}

	private _updateIndex(name: string, description: string): void {
		const indexFile = join(this.dir, INDEX_FILENAME);
		const existing = existsSync(indexFile) ? readFileSync(indexFile, "utf-8") : "# Memory Index\n";
		const newLine = `- [${name}](${name}.md) — ${description}`;
		const lines = existing.split("\n");
		// Anchor to the exact entry prefix to avoid false matches when another
		// memory's description happens to contain '[name](' as a Markdown link.
		const entryPrefix = `- [${name}](${name}.md)`;
		const idx = lines.findIndex((l) => l.startsWith(entryPrefix));
		if (idx >= 0) {
			lines[idx] = newLine;
		} else {
			// Append before trailing blank lines
			const lastNonEmpty = lines.reduce((acc, l, i) => (l.trim() ? i : acc), -1);
			lines.splice(lastNonEmpty + 1, 0, newLine);
		}
		writeFileSync(indexFile, lines.join("\n"), "utf-8");
	}

	private _removeFromIndex(name: string): void {
		const indexFile = join(this.dir, INDEX_FILENAME);
		if (!existsSync(indexFile)) return;
		// Use the exact entry prefix so that other entries whose description
		// contains '[name](' as a Markdown link are not accidentally removed.
		const entryPrefix = `- [${name}](${name}.md)`;
		const lines = readFileSync(indexFile, "utf-8")
			.split("\n")
			.filter((l) => !l.startsWith(entryPrefix));
		writeFileSync(indexFile, lines.join("\n"), "utf-8");
	}
}
