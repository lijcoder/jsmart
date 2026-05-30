// ── Defaults ────────────────────────────────────────────────────────

import type { FsProvider } from "../providers/types.js";

export const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024; // 32 KB
export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_LINE_LENGTH = 2000;

const SKIP_DIRS = new Set(["node_modules", ".git"]);

// Binary file extensions that should never be read as text
const BINARY_EXTENSIONS = new Set([
	".zip",
	".tar",
	".gz",
	".bz2",
	".xz",
	".7z",
	".rar",
	".exe",
	".dll",
	".so",
	".dylib",
	".bin",
	".obj",
	".o",
	".a",
	".lib",
	".png",
	".jpg",
	".jpeg",
	".gif",
	".bmp",
	".ico",
	".webp",
	".tiff",
	".tif",
	".mp3",
	".mp4",
	".avi",
	".mov",
	".wav",
	".flac",
	".ogg",
	".webm",
	".mkv",
	".pdf",
	".wasm",
	".class",
	".jar",
	".pyc",
	".pyd",
	".pyo",
	".whl",
	".egg",
	".ttf",
	".otf",
	".woff",
	".woff2",
	".eot",
	".sqlite",
	".db",
	".DS_Store",
]);

export interface CreateFsToolsOptions {
	/** Maximum output size in bytes for read/list/grep responses. Defaults to 32 KB. */
	maxOutputBytes?: number;
	/** Maximum number of lines or entries returned before pagination. Defaults to 2000. */
	maxLines?: number;
	/** Maximum characters per line before truncation in read/grep responses. Defaults to 2000. */
	maxLineLength?: number;
}

export function isBinaryPath(filePath: string): boolean {
	const lastDot = filePath.lastIndexOf(".");
	if (lastDot === -1) return false;
	return BINARY_EXTENSIONS.has(filePath.slice(lastDot).toLowerCase());
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Simple path join that works with forward slashes. */
export function joinPath(base: string, name: string): string {
	if (base.endsWith("/")) return base + name;
	return `${base}/${name}`;
}

/** Compute a relative path from root to target. */
export function relativePath(root: string, target: string): string {
	const normalizedRoot = root.endsWith("/") ? root : `${root}/`;
	if (target.startsWith(normalizedRoot)) {
		return target.slice(normalizedRoot.length);
	}
	return target;
}

/** Extract directory portion of a path. */
export function dirname(filePath: string): string {
	const lastSlash = filePath.lastIndexOf("/");
	if (lastSlash === -1) return ".";
	return filePath.slice(0, lastSlash);
}

export function takeItemsWithinByteLimit<T>(items: T[], maxBytes: number): { items: T[]; truncatedByBytes: boolean } {
	let totalBytes = 0;
	const limitedItems: T[] = [];

	for (const item of items) {
		const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf-8");
		if (totalBytes + itemBytes > maxBytes) {
			return { items: limitedItems, truncatedByBytes: true };
		}

		totalBytes += itemBytes;
		limitedItems.push(item);
	}

	return { items: limitedItems, truncatedByBytes: false };
}

/** Recursively walk a directory, returning absolute paths of files only. Skips node_modules and .git. */
export async function walkFiles(fs: FsProvider, dir: string): Promise<string[]> {
	const entries = await fs.readdir(dir);
	const files: string[] = [];

	for (const entry of entries) {
		const full = joinPath(dir, entry.name);
		if (entry.isDirectory) {
			if (!SKIP_DIRS.has(entry.name)) {
				files.push(...(await walkFiles(fs, full)));
			}
		} else {
			files.push(full);
		}
	}

	return files;
}

export function truncateLine(line: string, maxLength: number): string {
	if (line.length <= maxLength) return line;
	return `${line.slice(0, maxLength)}...·(line·truncated·at·${maxLength}·chars)`;
}
