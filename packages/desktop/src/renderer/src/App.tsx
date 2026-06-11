import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentSessionEvent } from "@jsmart/jsmart-harness";
import type { SessionInfo, SessionMeta } from "../../preload/index.js";
import { type UIMessage, type UIContentBlock, type UIToolCall } from "./lib/types.js";
import { MarkdownRenderer } from "./components/MarkdownRenderer.js";
import { ToolCard } from "./components/ToolCard.js";

interface SavedSession {
	id: string;
	workspace: string;
	title: string;
	mtime: number;
}

export function App() {
	const [savedSessions, setSavedSessions] = useState<SavedSession[]>([]);
	const [activeId, setActiveId] = useState<string | null>(null);
	const [activeProjectDir, setActiveProjectDir] = useState<string>("");
	const [input, setInput] = useState("");
	const [sidebarWidth, setSidebarWidth] = useState(260);
	const [collapsedWorkspaces, setCollapsedWorkspaces] = useState<Set<string>>(new Set());
	const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
	const [editTitle, setEditTitle] = useState("");

	const startEditTitle = (sessionId: string, currentTitle: string) => {
		setEditingSessionId(sessionId);
		setEditTitle(currentTitle);
	};

	const saveEditTitle = async () => {
		if (!editingSessionId || !editTitle.trim()) {
			setEditingSessionId(null);
			return;
		}
		await window.jsmart.app.updateTitle(editingSessionId, editTitle.trim());
		await refreshSavedSessions();
		setEditingSessionId(null);
	};

	const toggleWorkspace = (ws: string) => {
		setCollapsedWorkspaces((prev) => {
			const next = new Set(prev);
			if (next.has(ws)) next.delete(ws);
			else next.add(ws);
			return next;
		});
	};

	// Group sessions by workspace
	const workspaceGroups = new Map<string, SavedSession[]>();
	for (const s of savedSessions) {
		const list = workspaceGroups.get(s.workspace) ?? [];
		list.push(s);
		workspaceGroups.set(s.workspace, list);
	}
	const messagesEndRef = useRef<HTMLDivElement>(null);
	const chatMessagesRef = useRef<HTMLDivElement>(null);
	const userScrolledUpRef = useRef(false);
	const sidebarRef = useRef<HTMLElement>(null);

	// Per-session state
	const sessionStatesRef = useRef<
		Map<string, { messages: UIMessage[]; streaming: UIMessage | null; running: boolean }>
	>(new Map());
	const [, setTick] = useState(0);
	const forceRender = () => setTick((t) => t + 1);

	const activeState = activeId ? sessionStatesRef.current.get(activeId) : null;
	const messages = activeState?.messages ?? [];
	const running = activeState?.running ?? false;
	const streamingMsg = activeState?.streaming ?? null;

	// Track manual scroll: wheel up → stop auto-scroll; scroll to bottom → resume
	useEffect(() => {
		const el = chatMessagesRef.current;
		if (!el) return;
		const onWheel = (e: WheelEvent) => {
			if (e.deltaY < 0) {
				userScrolledUpRef.current = true;
			}
		};
		const onScroll = () => {
			const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
			if (isAtBottom) {
				userScrolledUpRef.current = false;
			}
		};
		el.addEventListener("wheel", onWheel);
		el.addEventListener("scroll", onScroll);
		return () => {
			el.removeEventListener("wheel", onWheel);
			el.removeEventListener("scroll", onScroll);
		};
	}, []);

	// Auto-scroll to bottom unless user manually scrolled up
	useEffect(() => {
		if (!userScrolledUpRef.current) {
			messagesEndRef.current?.scrollIntoView({ behavior: "instant" });
		}
	}, [messages]);

	// Also auto-scroll during active streaming
	useEffect(() => {
		if (!userScrolledUpRef.current && streamingMsg) {
			messagesEndRef.current?.scrollIntoView({ behavior: "instant" });
		}
	}, [streamingMsg?.blocks]);

	// Load saved sessions on mount
	const refreshSavedSessions = useCallback(async () => {
		const list = await window.jsmart.app.listSessions();
		setSavedSessions(
			list.map((s) => ({
				id: s.id,
				workspace: s.workspace,
				title: s.title,
				mtime: s.mtime,
			})),
		);
	}, []);

	useEffect(() => {
		refreshSavedSessions();
	}, [refreshSavedSessions]);

	// Listen for ALL session events (not tied to activeId)
	useEffect(() => {
		const unsub = window.jsmart.session.onEvent((sessionId, event) => {
			const state = sessionStatesRef.current.get(sessionId);
			if (!state) return;

			switch (event.type) {
				case "agent_start":
					state.running = true;
					state.streaming = { id: "streaming", role: "assistant", blocks: [] };
					break;

				case "message_update": {
					const e = event.assistantMessageEvent;
					const stream = state.streaming;
					if (!stream) return;
					let newBlocks = stream.blocks;
					switch (e.type) {
						case "text_delta":
							newBlocks = addTextBlock(newBlocks, e.delta);
							break;
						case "thinking_delta":
							newBlocks = addThinkingBlock(newBlocks, e.delta);
							break;
						case "toolcall_start": {
							const tc = e.partial.content?.[e.contentIndex];
							newBlocks = addToolBlock(newBlocks, {
								id: tc?.type === "toolCall" ? tc.id : crypto.randomUUID(),
								name: tc?.type === "toolCall" ? tc.name : "unknown",
								args: tc?.type === "toolCall" ? (tc.arguments as Record<string, unknown>) ?? {} : {},
								status: "pending",
							});
							break;
						}
						case "toolcall_end":
							newBlocks = newBlocks.map((b) => {
								if (b.type === "tool_call" && b.toolCall?.status === "pending") {
									return {
										...b,
										toolCall: {
											...b.toolCall,
											name: e.toolCall.name,
											id: e.toolCall.id,
											args: (e.toolCall.arguments as Record<string, unknown>) ?? {},
											status: "running" as const,
										},
									};
								}
								return b;
							});
							break;
					}
					state.streaming = { ...stream, blocks: newBlocks };
					break;
				}

				case "tool_execution_start":
					if (state.streaming) {
						state.streaming = {
							...state.streaming,
							blocks: updateToolBlock(state.streaming.blocks, event.toolCallId, { status: "running" }),
						};
					}
					break;

				case "tool_execution_end":
					if (state.streaming) {
						state.streaming = {
							...state.streaming,
							blocks: updateToolBlock(state.streaming.blocks, event.toolCallId, {
								status: event.isError ? "error" : "done",
								result: event.result,
							}),
						};
					}
					break;

				case "agent_end": {
					const stream = state.streaming;
					state.running = false;
					state.streaming = null;
					if (stream && stream.blocks.length > 0) {
						state.messages = [...state.messages, { ...stream, id: crypto.randomUUID() }];
					}
					break;
				}
			}

			// Trigger re-render if this is the active session
			if (sessionId === activeId) {
				forceRender();
			}
		});
		return unsub;
	}, [activeId]);

	const handleCreateSession = async () => {
		const dir = await window.jsmart.app.selectProject();
		if (!dir) return;
		const info = await window.jsmart.session.create(dir);
		sessionStatesRef.current.set(info.id, { messages: [], streaming: null, running: false });
		setActiveId(info.id);
		setActiveProjectDir(dir);
		setInput("");
		userScrolledUpRef.current = false;
		await refreshSavedSessions();
	};

	const handleSelectSavedSession = async (sessionId: string, workspace: string) => {
		setActiveId(sessionId);
		setActiveProjectDir(workspace);
		setInput("");
		userScrolledUpRef.current = false;

		const needsCreate = !sessionStatesRef.current.has(sessionId);
		if (needsCreate) {
			sessionStatesRef.current.set(sessionId, { messages: [], streaming: null, running: false });
			await window.jsmart.session.create(workspace, sessionId);
		}

		const state = sessionStatesRef.current.get(sessionId)!;
		if (state.messages.length === 0 && !state.streaming) {
			const historyMessages = await window.jsmart.app.loadHistory(workspace, sessionId);
			const uiMessages: UIMessage[] = [];
			let currentAssistant: UIMessage | null = null;

			for (const msg of historyMessages) {
				const m = msg as { role?: string; content?: unknown };
				if (m.role === "user") {
					if (currentAssistant && currentAssistant.blocks.length > 0) {
						uiMessages.push(currentAssistant);
						currentAssistant = null;
					}
					uiMessages.push({ id: crypto.randomUUID(), role: "user", blocks: [{ type: "user_text", text: extractText(m.content) }] });
				} else if (m.role === "assistant") {
					if (!currentAssistant) {
						currentAssistant = { id: crypto.randomUUID(), role: "assistant", blocks: [] };
					}
					currentAssistant.blocks.push(...contentToBlocks(m.content));
				}
			}
			if (currentAssistant && currentAssistant.blocks.length > 0) {
				uiMessages.push(currentAssistant);
			}
			state.messages = uiMessages;
		}
		forceRender();

	};

	const handleDeleteSession = async (id: string) => {
		await window.jsmart.session.delete(id);
		sessionStatesRef.current.delete(id);
		if (activeId === id) {
			setActiveId(null);
		}
		await refreshSavedSessions();
	};

	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const composingRef = useRef(false);

	// Sidebar resize
	const handleResizeStart = useCallback(() => {
		const onMove = (e: MouseEvent) => {
			const w = Math.max(180, Math.min(500, e.clientX));
			setSidebarWidth(w);
		};
		const onUp = () => {
			document.removeEventListener("mousemove", onMove);
			document.removeEventListener("mouseup", onUp);
		};
		document.addEventListener("mousemove", onMove);
		document.addEventListener("mouseup", onUp);
	}, []);

	const handleSend = () => {
		if (!activeId) return;
		const state = sessionStatesRef.current.get(activeId);
		if (!state || state.running) return;
		const text = input.trim();
		if (!text) return;

		userScrolledUpRef.current = false;
		setInput("");
		if (textareaRef.current) {
			textareaRef.current.value = "";
		}
		state.messages = [...state.messages, { id: crypto.randomUUID(), role: "user", blocks: [{ type: "user_text", text }] }];

		// Auto-title from first message, but only if still default "未命名"
		const currentTitle = savedSessions.find((s) => s.id === activeId)?.title;
		if (state.messages.length === 1 && (!currentTitle || currentTitle === "未命名")) {
			window.jsmart.app.updateTitle(activeId, text.slice(0, 50));
			refreshSavedSessions();
		}

		window.jsmart.session.prompt(activeId, text);
		forceRender();
	};

	const handleAbort = async () => {
		if (!activeId) return;
		await window.jsmart.session.abort(activeId);
	};

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter" && !e.shiftKey && !composingRef.current) {
			e.preventDefault();
			handleSend();
		}
	};

	// Display messages: finalized + streaming
	const displayMessages = [
		...messages,
		...(streamingMsg ? [streamingMsg] : []),
	];

	return (
		<div className="app">
			<aside className="sidebar" ref={sidebarRef} style={{ width: sidebarWidth, minWidth: sidebarWidth }}>
				<button type="button" className="btn-new" onClick={handleCreateSession}>
					+ New Session
				</button>
				<div className="session-list">
					{[...workspaceGroups.entries()].map(([workspace, sessions]) => {
						const isCollapsed = collapsedWorkspaces.has(workspace);
						const wsName = workspace.split("/").pop() || workspace;
						return (
							<div key={workspace} className="workspace-group">
								<button
									type="button"
									className="workspace-header"
									onClick={() => toggleWorkspace(workspace)}
								>
									<span className="workspace-chevron">{isCollapsed ? "\u25B6" : "\u25BC"}</span>
									<span className="workspace-name">{wsName}</span>
									<span className="workspace-count">{sessions.length}</span>
								</button>
								{!isCollapsed && sessions.map((s) => (
										<div key={s.id} className={`session-item ${s.id === activeId ? "active" : ""}`}>
											{editingSessionId === s.id ? (
												<input
													className="session-edit-input"
													value={editTitle}
													onChange={(e) => setEditTitle(e.target.value)}
													onBlur={saveEditTitle}
													onKeyDown={(e) => {
														if (e.key === "Enter") saveEditTitle();
														if (e.key === "Escape") setEditingSessionId(null);
													}}
													autoFocus
												/>
											) : (
												<button
													type="button"
													className="session-btn"
													onClick={() => handleSelectSavedSession(s.id, s.workspace)}
													onDoubleClick={() => startEditTitle(s.id, s.title)}
												>
													<span className="session-name">{s.title}</span>
												</button>
											)}
											<button
												type="button"
												className="btn-delete"
												onClick={(e) => {
													e.stopPropagation();
													handleDeleteSession(s.id);
												}}
											>
												x
											</button>
										</div>
									))}
							</div>
						);
					})}
				</div>
			</aside>
			<div className="sidebar-resizer" onMouseDown={handleResizeStart} />

			<main className="main">
				{activeId ? (
					<>
						<div className="chat-messages" ref={chatMessagesRef}>
							{displayMessages.length === 0 && !running && (
								<div className="empty-state">
									<p>Start a conversation with the coding agent.</p>
								</div>
							)}
							{displayMessages.map((msg) => (
								<MessageBubble key={msg.id} message={msg} />
							))}
							<div ref={messagesEndRef} />
						</div>

						<div className="chat-input">
							<div className="input-wrapper">
								<textarea
									ref={textareaRef}
									value={input}
									onChange={(e) => setInput(e.target.value)}
									onKeyDown={handleKeyDown}
									onCompositionStart={() => { composingRef.current = true; }}
									onCompositionEnd={() => { composingRef.current = false; }}
									placeholder="Enter to send, Shift+Enter for newline"
									rows={2}
								/>
								{running ? (
									<button type="button" className="btn-abort" onClick={handleAbort}>
										Stop
									</button>
								) : (
									<button type="button" className="btn-send" onClick={handleSend}>
										Send
									</button>
								)}
								<div className="input-meta">
									<span className="input-project">{activeProjectDir.split("/").pop() || activeProjectDir}</span>
								</div>
							</div>
						</div>
					</>
				) : (
					<div className="empty-state">
						<h2>No session selected</h2>
						<p>Create a new session or select one from the sidebar.</p>
					</div>
				)}
			</main>
		</div>
	);
}

// ── Message Bubble ────────────────────────────────────────────────


function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return (content as Array<{ type?: string; text?: string }>)
			.filter((p) => p.type === "text")
			.map((p) => p.text ?? "")
			.join("");
	}
	return "";
}

function contentToBlocks(content: unknown): UIContentBlock[] {
	if (!Array.isArray(content)) return [];
	const blocks: UIContentBlock[] = [];
	for (const item of content as Array<{ type: string; text?: string; thinking?: string; name?: string; id?: string; arguments?: unknown }>) {
		if (item.type === "text" && item.text) {
			blocks.push({ type: "text", text: item.text });
		} else if (item.type === "thinking" && item.thinking) {
			blocks.push({ type: "thinking", text: item.thinking });
		} else if (item.type === "toolCall" && item.name) {
			blocks.push({
				type: "tool_call",
				toolCall: {
					id: item.id ?? crypto.randomUUID(),
					name: item.name,
					args: (item.arguments as Record<string, unknown>) ?? {},
					status: "done",
				},
			});
		}
	}
	return blocks;
}

function MessageBubble({ message }: { message: UIMessage }) {
	const isStreaming = message.id === "streaming";
	const isAssistant = message.role === "assistant";

	if (message.role === "user") {
		return (
			<div className="message message-user">
				<div className="message-content">
					{message.blocks.map((block, i) => (
						<ContentBlock key={i} block={block} isStreaming={false} />
					))}
				</div>
			</div>
		);
	}

	// For assistant: only last text block is visible, everything else in details
	const allBlocks = message.blocks;
	// Find the index of the last text block
	let lastTextIdx = -1;
	for (let i = allBlocks.length - 1; i >= 0; i--) {
		if (allBlocks[i].type === "text") {
			lastTextIdx = i;
			break;
		}
	}
	const detailBlocks = allBlocks.filter((_, i) => i !== lastTextIdx);
	const lastTextBlock = lastTextIdx >= 0 ? allBlocks[lastTextIdx] : null;
	const hasDetails = detailBlocks.length > 0 || isStreaming;

	return (
		<div className="message message-assistant">
			<div className="message-content">
				{hasDetails && (
					<details className="message-details">
						<summary className="message-details-summary">
							{isStreaming ? "处理中..." : `${detailBlocks.length} 项详情`}
						</summary>
						<div className="message-details-body">
							{detailBlocks.map((block, i) => (
								<ContentBlock key={i} block={block} isStreaming={isStreaming} />
							))}
						</div>
					</details>
				)}
				{lastTextBlock && (
					<ContentBlock block={lastTextBlock} isStreaming={isStreaming} />
				)}
			</div>
		</div>
	);
}

function ContentBlock({ block, isStreaming: _isStreaming }: { block: UIContentBlock; isStreaming: boolean }) {
	switch (block.type) {
		case "text":
			if (!block.text) return null;
			return <MarkdownRenderer content={block.text} />;
		case "user_text":
			if (!block.text) return null;
			return <div className="user-text">{block.text}</div>;
		case "thinking":
			return block.text ? (
				<details className="thinking-block">
					<summary className="thinking-summary">Thinking...</summary>
					<div className="thinking-content">{block.text}</div>
				</details>
			) : null;
		case "tool_call":
			return block.toolCall ? <ToolCard toolCall={block.toolCall} /> : null;
		default:
			return null;
	}
}

// ── Event Handler ──────────────────────────────────────────────────

function createBlocks(): UIContentBlock[] {
	return [];
}

function addTextBlock(blocks: UIContentBlock[], delta: string): UIContentBlock[] {
	const last = blocks[blocks.length - 1];
	if (last?.type === "text") {
		// Replace with new object to trigger React re-render
		return [...blocks.slice(0, -1), { type: "text" as const, text: (last.text ?? "") + delta }];
	}
	return [...blocks, { type: "text", text: delta }];
}

function addThinkingBlock(blocks: UIContentBlock[], delta: string): UIContentBlock[] {
	const last = blocks[blocks.length - 1];
	if (last?.type === "thinking") {
		return [...blocks.slice(0, -1), { type: "thinking" as const, text: (last.text ?? "") + delta }];
	}
	return [...blocks, { type: "thinking", text: delta }];
}

function addToolBlock(blocks: UIContentBlock[], toolCall: UIToolCall): UIContentBlock[] {
	return [...blocks, { type: "tool_call", toolCall: { ...toolCall } }];
}

function updateToolBlock(blocks: UIContentBlock[], toolCallId: string, update: Partial<UIToolCall>): UIContentBlock[] {
	return blocks.map((b) => {
		if (b.type === "tool_call" && b.toolCall?.id === toolCallId) {
			return { ...b, toolCall: { ...b.toolCall, ...update } };
		}
		return b;
	});
}

function handleEvent(
	event: AgentSessionEvent,
	streamingRef: React.MutableRefObject<UIMessage | null>,
	setMessages: React.Dispatch<React.SetStateAction<UIMessage[]>>,
	setRunning: React.Dispatch<React.SetStateAction<boolean>>,
	setStatusText: React.Dispatch<React.SetStateAction<string>>,
) {
	switch (event.type) {
		case "agent_start": {
			setRunning(true);
			setStatusText("Processing...");
			streamingRef.current = { id: "streaming", role: "assistant", blocks: [] };
			setMessages((prev) => [...prev]);
			break;
		}

		case "message_update": {
			const e = event.assistantMessageEvent;
			const stream = streamingRef.current;
			if (!stream) return;

			let newBlocks = stream.blocks;
			switch (e.type) {
				case "text_delta":
					newBlocks = addTextBlock(newBlocks, e.delta);
					break;
				case "thinking_delta":
					newBlocks = addThinkingBlock(newBlocks, e.delta);
					break;
				case "toolcall_start": {
					const tc = e.partial.content?.[e.contentIndex];
					newBlocks = addToolBlock(newBlocks, {
						id: tc?.type === "toolCall" ? tc.id : crypto.randomUUID(),
						name: tc?.type === "toolCall" ? tc.name : "unknown",
						args: tc?.type === "toolCall" ? (tc.arguments as Record<string, unknown>) ?? {} : {},
						status: "pending",
					});
					break;
				}
				case "toolcall_end":
					newBlocks = updateToolBlock(
						// Update the last pending tool block
						newBlocks.map((b, i) => {
							if (b.type === "tool_call" && b.toolCall?.status === "pending") {
								return {
									...b,
									toolCall: {
										...b.toolCall,
										name: e.toolCall.name,
										id: e.toolCall.id,
										args: (e.toolCall.arguments as Record<string, unknown>) ?? {},
										status: "running" as const,
									},
								};
							}
							return b;
						}),
						"",
						{},
					);
					break;
			}
			streamingRef.current = { ...stream, blocks: newBlocks };
			// Trigger re-render to show new text
			setMessages((prev) => [...prev]);
			break;
		}

		case "tool_execution_start": {
			const stream = streamingRef.current;
			if (!stream) return;
			streamingRef.current = {
				...stream,
				blocks: updateToolBlock(stream.blocks, event.toolCallId, { status: "running" }),
			};
			setMessages((prev) => [...prev]);
			break;
		}

		case "tool_execution_end": {
			const stream = streamingRef.current;
			if (!stream) return;
			streamingRef.current = {
				...stream,
				blocks: updateToolBlock(stream.blocks, event.toolCallId, {
					status: event.isError ? "error" : "done",
					result: event.result,
				}),
			};
			setMessages((prev) => [...prev]);
			break;
		}

		case "agent_end": {
			const stream = streamingRef.current;
			streamingRef.current = null;
			setRunning(false);
			setStatusText("Done");
			setTimeout(() => setStatusText(""), 2000);
			if (stream && stream.blocks.length > 0) {
				setMessages((prev) => [...prev, { ...stream, id: crypto.randomUUID() }]);
			}
			break;
		}
	}
}
