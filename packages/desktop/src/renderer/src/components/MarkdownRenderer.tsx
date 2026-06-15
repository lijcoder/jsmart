import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { useCodeBlockComponents } from "./CodeBlock.js";
import { useCallback, useMemo } from "react";

interface MarkdownRendererProps {
	content: string;
}

export function MarkdownRenderer({ content }: MarkdownRendererProps) {
	const codeBlockComponents = useCodeBlockComponents();

	const handleLinkClick = useCallback((href: string) => {
		window.jsmart.app.openExternal(href);
	}, []);

	const components = useMemo(
		() => ({
			...codeBlockComponents,
			a: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => {
				if (!href) return <a {...props}>{children}</a>;
				return (
					<a
						href={href}
						onClick={(e) => {
							e.preventDefault();
							handleLinkClick(href);
						}}
						style={{ cursor: "pointer" }}
						{...props}
					>
						{children}
					</a>
				);
			},
		}),
		[codeBlockComponents, handleLinkClick],
	);

	return (
		<ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={components}>
			{content}
		</ReactMarkdown>
	);
}
