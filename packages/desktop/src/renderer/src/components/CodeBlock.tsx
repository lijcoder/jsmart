import { useCallback, useMemo, useState } from "react";

interface CodeBlockProps {
	children: React.ReactNode;
	className?: string;
}

const MAX_VISIBLE_LINES = 16;
const COLLAPSED_LINES = 8;

function extractText(children: React.ReactNode): string {
	if (typeof children === "string") return children;
	if (Array.isArray(children)) return children.map(extractText).join("");
	if (children && typeof children === "object" && "props" in children) {
		return extractText((children as React.ReactElement).props.children);
	}
	return "";
}

export function CodeBlock({ children, className }: CodeBlockProps) {
	const code = extractText(children);
	const lineCount = code.split("\n").length;
	const shouldCollapse = lineCount > MAX_VISIBLE_LINES;
	const [expanded, setExpanded] = useState(false);
	const [copied, setCopied] = useState(false);

	const handleCopy = useCallback(async () => {
		try {
			await navigator.clipboard.writeText(code);
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		} catch {
			// fallback
		}
	}, [code]);

	const langMatch = className?.match(/language-(\w+)/);
	const lang = langMatch ? langMatch[1] : undefined;

	return (
		<div className="code-block-wrapper">
			<div className="code-block-header">
				{lang && <span className="code-block-lang">{lang}</span>}
				<button type="button" className="code-block-copy" onClick={handleCopy}>
					{copied ? "已复制" : "复制"}
				</button>
			</div>
			<div className={`code-block-body${shouldCollapse && !expanded ? " collapsed" : ""}`}>
				<pre className="code-block">
					<code className={className}>{children}</code>
				</pre>
			</div>
			{shouldCollapse && !expanded && (
				<button
					type="button"
					className="code-block-expand"
					onClick={() => setExpanded(true)}
				>
					展开全部 ({lineCount} 行)
				</button>
			)}
			{shouldCollapse && expanded && (
				<button
					type="button"
					className="code-block-expand"
					onClick={() => setExpanded(false)}
				>
					收起
				</button>
			)}
		</div>
	);
}

export function useCodeBlockComponents() {
	return useMemo(
		() => ({
			pre({ children }: { children: React.ReactNode }) {
				// All <pre> in markdown are code blocks — extract language from child <code>
				const codeChild = Array.isArray(children) ? children[0] : children;
				let className: string | undefined;
				let codeChildren: React.ReactNode = children;
				if (
					codeChild &&
					typeof codeChild === "object" &&
					"props" in codeChild
				) {
					const props = (codeChild as React.ReactElement).props as {
						className?: string;
						children?: React.ReactNode;
					};
					if (props.className) className = props.className;
					if (props.children !== undefined) codeChildren = props.children;
				}
				return <CodeBlock className={className}>{codeChildren}</CodeBlock>;
			},
		}),
		[],
	);
}
