import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";

interface MarkdownRendererProps {
	content: string;
}

export function MarkdownRenderer({ content }: MarkdownRendererProps) {
	const components = useMemo(
		() => ({
			pre({ children }: { children: React.ReactNode }) {
				return <pre className="code-block">{children}</pre>;
			},
			code({ className, children, ...props }: { className?: string; children: React.ReactNode }) {
				const isInline = !className;
				if (isInline) {
					return (
						<code className="inline-code" {...props}>
							{children}
						</code>
					);
				}
				return (
					<code className={className} {...props}>
						{children}
					</code>
				);
			},
		}),
		[],
	);

	return (
		<ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={components}>
			{content}
		</ReactMarkdown>
	);
}
