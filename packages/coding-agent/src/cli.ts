#!/usr/bin/env node
/**
 * Coding Agent CLI entry point.
 *
 * Usage:
 *   npx tsx src/cli.ts              # uses current directory
 *   npx tsx src/cli.ts --init       # initialize global config
 *   npx tsx src/cli.ts --workspace /path/to/project
 *   npx tsx src/cli.ts --json "prompt"  # non-interactive JSON output
 *   echo "prompt" | npx tsx src/cli.ts --json  # JSON from stdin
 *   npx tsx src/cli.ts --json --workspace /path "prompt"
 *   npx tsx src/cli.ts --json --model openai/gpt-4o "prompt"
 *
 * Keys:
 *   Enter        - Submit input
 *   Ctrl+J       - Insert newline (multi-line input)
 *   ESC          - Abort running agent
 *   Ctrl+C       - Exit
 *   Ctrl+L       - Clear screen
 */

import { CodingSession } from "./coding-session.js";
import { initGlobalConfig, listSessionFiles, loadConfig } from "./config.js";
import { colorize, handleAgentEvent } from "./event-output.js";
import { JsonSessionCollector } from "./json-output.js";

// ── ANSI helpers ────────────────────────────────────────────────────

const ESC = "\x1b";
const CLEAR_LINE = `${ESC}[2K`;

function show(text: string): void {
	process.stdout.write(`${text}\n`);
}

function writePrompt(text: string): void {
	process.stdout.write(`${text} `);
}

// ── Argument parsing ───────────────────────────────────────────────

interface ParsedArgs {
	init: boolean;
	json: boolean;
	workspace: string;
	sessionId?: string;
	model?: string;
	/** Positional arguments after all flags, used as prompt in --json mode. */
	positional: string[];
}

const FLAGS_WITH_VALUE = new Set(["--workspace", "--session", "--model"]);
const BOOLEAN_FLAGS = new Set(["--init", "--json"]);

function parseArgs(argv: string[]): ParsedArgs {
	const result: ParsedArgs = {
		init: false,
		json: false,
		workspace: process.cwd(),
		positional: [],
	};

	let i = 2; // skip node and script path
	while (i < argv.length) {
		const arg = argv[i];

		if (BOOLEAN_FLAGS.has(arg)) {
			if (arg === "--init") result.init = true;
			if (arg === "--json") result.json = true;
			i++;
			continue;
		}

		if (FLAGS_WITH_VALUE.has(arg)) {
			const value = argv[i + 1];
			if (value && !value.startsWith("--")) {
				if (arg === "--workspace") result.workspace = value;
				if (arg === "--session") result.sessionId = value;
				if (arg === "--model") result.model = value;
				i += 2;
				continue;
			}
			// value missing or looks like another flag — skip flag
			i++;
			continue;
		}

		// positional argument
		result.positional.push(arg);
		i++;
	}

	return result;
}

// ── Command parsing ─────────────────────────────────────────────────

function parseCommand(input: string): string[] {
	return input.split(/\s+/);
}

// ── JSON (non-interactive) mode ────────────────────────────────────

/**
 * Resolve the user prompt for JSON mode.
 * Uses positional args from ParsedArgs, or reads from stdin.
 */
async function resolveJsonPrompt(args: ParsedArgs): Promise<string> {
	if (args.positional.length > 0) {
		return args.positional.join(" ");
	}

	// Read from stdin if not a TTY
	if (!process.stdin.isTTY) {
		process.stdin.setEncoding("utf8");
		let data = "";
		for await (const chunk of process.stdin) {
			data += chunk;
		}
		return data.trim();
	}

	throw new Error('No prompt provided. Usage: jsmart-coding --json "your prompt" or pipe via stdin.');
}

async function runJsonMode(args: ParsedArgs): Promise<void> {
	// Load configuration
	const { config, error } = loadConfig(args.workspace, args.sessionId);
	if (error || !config) {
		process.stderr.write(`Error loading config: ${error}\n`);
		process.exit(1);
	}

	// Resolve prompt
	let prompt: string;
	try {
		prompt = await resolveJsonPrompt(args);
	} catch (e) {
		process.stderr.write(`${(e as Error).message}\n`);
		process.exit(1);
	}

	if (!prompt) {
		process.stderr.write("Error: empty prompt.\n");
		process.exit(1);
	}

	// Create coding session
	const session = new CodingSession(config.projectDir, config);

	// Apply model override if specified
	if (args.model && !applyModel(session, args.model, true)) {
		process.exit(1);
	}

	// Set up collector
	const collector = new JsonSessionCollector();
	collector.setMetadata({
		systemPrompt: session.getSystemPrompt(),
		model: session.getCurrentModel(),
		workspace: session.getWorkspace(),
		tools: session.getTools(),
		skills: session.getSkills(),
	});
	collector.setRequest(prompt);

	// Collect events
	session.subscribe((event) => {
		collector.feed(event);
	});

	// Run the prompt
	try {
		await session.prompt(prompt);
	} catch (err) {
		if ((err as Error).name !== "AbortError") {
			process.stderr.write(`Error: ${err}\n`);
			process.exit(1);
		}
	}

	// Output structured JSON at the end
	const output = collector.finalize();
	process.stdout.write(`${JSON.stringify(output)}\n`);

	process.exit(0);
}

// ── Main ────────────────────────────────────────────────────────────

/** Apply --model override in provider/model format. Returns false on error. */
function applyModel(session: CodingSession, model: string, toStderr: boolean): boolean {
	const slashIdx = model.indexOf("/");
	if (slashIdx === -1) {
		const msg = "Error: --model format must be provider/model (e.g. openai/gpt-4o)";
		if (toStderr) process.stderr.write(`${msg}\n`);
		else show(msg);
		return false;
	}
	const provider = model.slice(0, slashIdx);
	const modelId = model.slice(slashIdx + 1);
	const result = session.changeModel(provider, modelId);
	if (!result.isSuccess) {
		const msg = `Error: ${result.error}`;
		if (toStderr) process.stderr.write(`${msg}\n`);
		else show(msg);
		return false;
	}
	return true;
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv);

	// Handle --init flag
	if (args.init) {
		const globalDir = initGlobalConfig();
		show(`Global config initialized at: ${globalDir}`);
		process.exit(0);
	}

	// Handle --json flag (non-interactive JSON output mode)
	if (args.json) {
		await runJsonMode(args);
		return;
	}

	// Load configuration
	const { config, error } = loadConfig(args.workspace, args.sessionId);
	if (error || !config) {
		show(`Error loading config: ${error}`);
		process.exit(1);
	}

	show(`Welcome to JSmart !!!`);
	show(`Project: ${config.projectDir}`);
	show(`Config: ${config.projectDirPath}`);
	show(`Model file: ${config.modelFile}`);
	show(`Skills: ${config.skillPaths.length > 0 ? config.skillPaths.join(", ") : "(none)"}`);
	show("");

	// Create coding session
	const session = new CodingSession(config.projectDir, config);

	// Apply model override if specified
	if (args.model) applyModel(session, args.model, false);

	// Subscribe to agent events
	session.subscribe(handleAgentEvent);

	show(`Session: ${session.getSessionFilePath()}`);
	show(`Model: ${session.getCurrentModel()}`);
	show("");
	show("Commands:");
	show("  /model              - Show current model");
	show("  /models             - List all available models");
	show("  /set model <p> <m>  - Change model");
	show("  /compact            - Compact context");
	show("  /tokens             - Show token count");
	show("  /prompt             - Show system prompt");
	show("  /session            - Show session file path");
	show("  /sessions           - List all saved sessions");
	show("  /multiline          - Enter multiline input mode (type /end to submit)");
	show("  /quit               - Exit");
	show("");
	show(`${ESC}[90mTip: Use --session <filename> to resume a previous session.${ESC}[0m`);
	show(`${ESC}[90mPress ESC to abort a running agent, Ctrl+C to exit.${ESC}[0m`);
	show(`${ESC}[90mPress Ctrl+J to insert a newline in your input.${ESC}[0m`);
	show("");

	// ── Raw mode setup ────────────────────────────────────────────

	if (!process.stdin.isTTY) {
		show("Error: Interactive mode requires a TTY.");
		process.exit(1);
	}

	process.stdin.setRawMode(true);
	process.stdin.resume();
	process.stdin.setEncoding("utf8");

	let inputBuffer = "";
	let isMultilineMode = false;
	let multilineBuffer = "";
	let isAgentRunning = false;
	let isExiting = false;

	// Track how many screen lines the prompt currently occupies
	let promptLineCount = 1;

	function getPromptText(): string {
		if (isMultilineMode) return "...";
		if (isAgentRunning) return "";
		return ">";
	}

	function renderPrompt(): void {
		const promptText = `${getPromptText()} ${inputBuffer}`;
		const newLineCount = promptText.split("\n").length;

		// Move cursor up to the first line of the previous prompt
		if (promptLineCount > 1) {
			process.stdout.write(`${ESC}[${promptLineCount - 1}A`);
		}

		// Clear all lines the previous prompt occupied
		for (let i = 0; i < promptLineCount; i++) {
			process.stdout.write(`${CLEAR_LINE}${ESC}[G`);
			if (i < promptLineCount - 1) {
				process.stdout.write(`${ESC}[E`); // cursor to next line
			}
		}

		// Move cursor back up to the first line
		if (promptLineCount > 1) {
			process.stdout.write(`${ESC}[${promptLineCount - 1}A`);
		}

		// Update line count and write the new prompt
		promptLineCount = newLineCount;
		process.stdout.write(promptText);
	}

	function handleAbort(): void {
		if (isAgentRunning) {
			session.abort()?.catch(() => {});
			// Don't print here — wait for agent_end event with stopReason="aborted"
		}
	}

	/** Clear the current prompt lines from the screen, cursor ends at first line */
	function clearPromptLines(): void {
		if (promptLineCount > 1) {
			process.stdout.write(`${ESC}[${promptLineCount - 1}A`);
		}
		for (let i = 0; i < promptLineCount; i++) {
			process.stdout.write(`${CLEAR_LINE}${ESC}[G`);
			if (i < promptLineCount - 1) {
				process.stdout.write(`${ESC}[E`);
			}
		}
		if (promptLineCount > 1) {
			process.stdout.write(`${ESC}[${promptLineCount - 1}A`);
		}
		promptLineCount = 1;
	}

	/** Reset prompt to a fresh single-line state (used after commands/submit) */
	function resetPrompt(): void {
		promptLineCount = 1;
		writePrompt(getPromptText());
	}

	async function handleSubmit(): Promise<void> {
		const text = isMultilineMode ? multilineBuffer : inputBuffer;

		if (isMultilineMode) {
			if (text.trim() === "/end") {
				isMultilineMode = false;
				multilineBuffer = "";
				inputBuffer = "";
				clearPromptLines();
				process.stdout.write("\n");
				resetPrompt();
				return;
			}
			multilineBuffer += `${inputBuffer}\n`;
			inputBuffer = "";
			renderPrompt();
			return;
		}

		const command = text.trim().toLowerCase();
		inputBuffer = "";

		// Clear old prompt lines, echo submitted text with User tag
		clearPromptLines();
		process.stdout.write(`\n${colorize("User", "user")}\n${text}\n`);

		if (!command) {
			resetPrompt();
			return;
		}

		// ── Commands ────────────────────────────────────────────

		if (command === "/quit") {
			isExiting = true;
			show(colorize("Goodbye!", "result"));
			cleanup();
			return;
		}

		if (command === "/multiline") {
			isMultilineMode = true;
			multilineBuffer = "";
			show(colorize("Multiline mode ON. Type /end to submit.", "result"));
			resetPrompt();
			return;
		}

		if (command === "/model") {
			show(`Current model: ${session.getCurrentModel()}`);
			resetPrompt();
			return;
		}

		if (command === "/models") {
			const models = session.getAllModels();
			show(models.length > 0 ? models.join("\n") : "No models available");
			resetPrompt();
			return;
		}

		if (command === "/compact") {
			const tokens = session.getContextTokens();
			show(`Context tokens: ${tokens}`);
			const result = await session.compact();
			if (result.isSuccess && result.result) {
				show(`Compacted ${result.result.tokensBefore} -> ${session.getContextTokens()} tokens`);
				show(`Summary:\n${result.result.summary}`);
			} else {
				show(`Error: ${result.error}`);
			}
			resetPrompt();
			return;
		}

		if (command === "/tokens") {
			show(`Context tokens: ${session.getContextTokens()}`);
			resetPrompt();
			return;
		}

		if (command === "/prompt") {
			show(session.getSystemPrompt());
			resetPrompt();
			return;
		}

		if (command === "/session") {
			show(`Session file: ${session.getSessionFilePath()}`);
			resetPrompt();
			return;
		}

		if (command === "/sessions") {
			// config is guaranteed non-null here (early exit above)
			const sessionFiles = listSessionFiles(config!.sessionsDir);
			if (sessionFiles.length === 0) {
				show("No saved sessions found.");
			} else {
				show(`Sessions in ${config!.sessionsDir}:`);
				for (const f of sessionFiles) {
					const marker = session.getSessionFilePath()?.endsWith(f.name) ? " *" : "  ";
					const time = f.mtime.toLocaleString();
					show(`${marker} ${f.name}  ${time}`);
				}
				show("");
				show("Use --session <filename> to resume a session.");
				show("(*) marks the current session.");
			}
			resetPrompt();
			return;
		}

		if (command.startsWith("/set model")) {
			const parts = parseCommand(command);
			if (parts.length < 4) {
				show("Usage: /set model <provider> <model>");
			} else {
				const { isSuccess, error } = session.changeModel(parts[2], parts[3]);
				show(isSuccess ? colorize("Model changed", "result") : `${colorize("Error", "error")}: ${error}`);
			}
			resetPrompt();
			return;
		}

		// ── Regular prompt ──────────────────────────────────────

		if (!isAgentRunning) {
			isAgentRunning = true;
			renderPrompt();
			try {
				await session.prompt(text.trim());
			} catch (err) {
				// abort() throws AbortError — event-output handles "Aborted" display
				if ((err as Error).name !== "AbortError") {
					show(`${colorize("Error", "error")}: ${err}`);
				}
			} finally {
				isAgentRunning = false;
				if (!isExiting) {
					resetPrompt();
				}
			}
		}
	}

	function cleanup(): void {
		process.stdin.setRawMode(false);
		process.stdin.pause();
		process.exit(0);
	}

	// ── Key handling ──────────────────────────────────────────────

	process.stdin.on("data", (key: Buffer | string) => {
		if (isExiting) return;

		const k = key.toString();

		// Ctrl+C → exit
		if (k === "\u0003") {
			isExiting = true;
			process.stdout.write("\n");
			show(colorize("Goodbye!", "result"));
			cleanup();
			return;
		}

		// Ctrl+L → clear screen
		if (k === "\u000c") {
			process.stdout.write(`${ESC}[2J${ESC}[H`);
			renderPrompt();
			return;
		}

		// ESC → abort agent
		if (k === ESC || k === "\u001b") {
			handleAbort();
			return;
		}

		// Don't accept input while agent is running (except ESC/Ctrl+C)
		if (isAgentRunning) return;

		// Ctrl+J → insert newline
		if (k === "\n") {
			inputBuffer += "\n";
			renderPrompt();
			return;
		}

		// Enter → submit
		if (k === "\r") {
			handleSubmit().catch((err) => {
				show(`${colorize("Error", "error")}: ${err}`);
				resetPrompt();
			});
			return;
		}

		// Backspace / Delete
		if (k === "\u007f" || k === "\b" || k === "\u0008") {
			const buf = isMultilineMode ? multilineBuffer : inputBuffer;
			if (buf.length > 0) {
				if (isMultilineMode) {
					multilineBuffer = buf.slice(0, -1);
				} else {
					inputBuffer = inputBuffer.slice(0, -1);
				}
				renderPrompt();
			}
			return;
		}

		// Ctrl+U → clear line
		if (k === "\u0015") {
			if (isMultilineMode) {
				multilineBuffer = "";
			} else {
				inputBuffer = "";
			}
			renderPrompt();
			return;
		}

		// Ignore other control characters
		if (k.charCodeAt(0) < 32 && k !== "\t") return;

		// Regular character → append to buffer
		if (isMultilineMode) {
			multilineBuffer += k;
		} else {
			inputBuffer += k;
		}
		renderPrompt();
	});

	// Handle process termination
	process.on("SIGTERM", cleanup);
	process.on("SIGINT", () => {
		isExiting = true;
		process.stdout.write("\n");
		show(colorize("Goodbye!", "result"));
		cleanup();
	});

	// Initial prompt
	resetPrompt();
}

main().catch((err) => {
	process.stdout.write(`\n${colorize("Fatal Error", "error")}: ${err}\n`);
	process.exit(1);
});
