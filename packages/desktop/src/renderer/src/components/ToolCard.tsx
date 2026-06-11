import { useState } from "react";
import type { UIToolCall } from "../lib/types.js";
import "./ToolCard.css";

interface ToolCardProps {
	toolCall: UIToolCall;
}

const MAX_PREVIEW_LENGTH = 500;

function formatValue(value: unknown): string {
	if (typeof value === "string") return value;
	return JSON.stringify(value, null, 2);
}

export function ToolCard({ toolCall }: ToolCardProps) {
	const [expanded, setExpanded] = useState(false);
	const { name, args, status, result } = toolCall;

	const statusIcon = status === "running"
		? "\u25B6"
		: status === "error"
			? "\u2717"
			: "\u2713";

	const statusClass = `tool-card tool-card-${status}`;
	const argsStr = formatValue(args);
	const resultStr = result !== undefined ? formatValue(result) : "";

	return (
		<div className={statusClass}>
			<button
				type="button"
				className="tool-card-header"
				onClick={() => setExpanded(!expanded)}
			>
				<span className="tool-card-icon">{statusIcon}</span>
				<span className="tool-card-name">{name}</span>
				{status === "running" && <span className="tool-card-spinner" />}
				<span className="tool-card-chevron">{expanded ? "\u25BC" : "\u25B6"}</span>
			</button>

			{expanded && (
				<div className="tool-card-body">
					<div className="tool-card-section">
						<div className="tool-card-label">Arguments</div>
						<pre className="tool-card-pre">{argsStr}</pre>
					</div>

					{status === "done" && resultStr && (
						<div className="tool-card-section">
							<div className="tool-card-label">Result</div>
							<pre className="tool-card-pre">
								{resultStr.length > MAX_PREVIEW_LENGTH
									? `${resultStr.slice(0, MAX_PREVIEW_LENGTH)}\n... (truncated)`
									: resultStr}
							</pre>
						</div>
					)}

					{status === "error" && resultStr && (
						<div className="tool-card-section">
							<div className="tool-card-label">Error</div>
							<pre className="tool-card-pre tool-card-error">{resultStr}</pre>
						</div>
					)}
				</div>
			)}
		</div>
	);
}
