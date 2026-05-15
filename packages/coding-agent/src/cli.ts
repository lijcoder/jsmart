#!/usr/bin/env node
/**
 * Coding Agent CLI entry point.
 *
 * Usage:
 *   npx tsx src/cli.ts              # uses current directory
 *   npx tsx src/cli.ts --init       # initialize global config
 *
 * Keys:
 *   Enter        - Submit input
 *   Ctrl+J       - Insert newline (multi-line input)
 *   ESC          - Abort running agent
 *   Ctrl+C       - Exit
 *   Ctrl+L       - Clear screen
 */

import { CodingSession } from "./coding-session.js";
import { initGlobalConfig, loadConfig } from "./config.js";
import { colorize, handleAgentEvent } from "./event-output.js";

// ── ANSI helpers ────────────────────────────────────────────────────

const ESC = "\x1b";
const CLEAR_LINE = `${ESC}[2K`;

function show(text: string): void {
	process.stdout.write(`${text}\n`);
}

function writePrompt(text: string): void {
	process.stdout.write(`${text} `);
}

// ── Command parsing ─────────────────────────────────────────────────

function parseCommand(input: string): string[] {
	return input.split(/\s+/);
}

// ── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	// Handle --init flag
	if (process.argv.includes("--init")) {
		const globalDir = initGlobalConfig();
		show(`Global config initialized at: ${globalDir}`);
		process.exit(0);
	}

	// Load configuration
	const { config, error } = loadConfig();
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
	show("  /session            - Show session file path");
	show("  /multiline          - Enter multiline input mode (type /end to submit)");
	show("  /quit               - Exit");
	show("");
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
			session.abort();
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

		if (command === "/session") {
			show(`Session file: ${session.getSessionFilePath()}`);
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
