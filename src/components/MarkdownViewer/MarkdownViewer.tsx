import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";
import "./MarkdownViewer.css";

interface MarkdownViewerProps {
  content?: string;
  onNavigate?: (path: string) => void;
}

/**
 * MarkdownViewer component displays markdown content with GitHub Flavored Markdown support and syntax highlighting.
 *
 * @param {string} content - The markdown content to render.
 * @param {(path: string) => void} onNavigate - Callback when a link is clicked, receives the navigation path.
 * @returns {JSX.Element} The rendered MarkdownViewer component.
 */
const CodeBlock = ({
  inline,
  className,
  children,
  ...props
}: Record<string, unknown>) => {
  const match = /language-(\w+)/.exec((className as string) || "");
  if (inline || !match) {
    return (
      <code {...props} className={className as string}>
        {children as React.ReactNode}
      </code>
    );
  }
  const lang = match[1];
  const langMap: Record<string, string> = {
    typescript: "typescript",
    ts: "ts",
    tsx: "tsx",
    javascript: "javascript",
    json: "json",
    bash: "bash",
    markdown: "markdown",
    css: "css",
    html: "html",
  };
  const language = langMap[lang] ?? "text";
  const content = React.Children.toArray(children)
    .join("")
    .replace(/\n$/, "");
  return (
    <SyntaxHighlighter
      {...props}
      style={vscDarkPlus as Record<string, React.CSSProperties>}
      language={language}
      PreTag="div"
    >
      {content}
    </SyntaxHighlighter>
  );
};

export const MarkdownViewer: React.FC<MarkdownViewerProps> = ({
  content = "",
  onNavigate,
}) => {
  return (
    <div className="markdown-viewer">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code: CodeBlock,
          /**
           * Render a link element for Markdown-rendered content.
           *
           * @param node The Markdown AST node.
           * @param href The hyperlink reference.
           * @param children The content to display within the link.
           * @param props Additional anchor element props.
           * @returns The rendered anchor element.
           */
          a({ node: _node, href, children, ...props }: Record<string, unknown>) {
            /**
             * Handle click events on the anchor element to navigate within markdown or delegate to external links.
             *
             * @param e The click event triggered on the anchor element.
             * @returns void
             */
            const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
              if (!href) return;

              if (href.startsWith("http")) {
                // Let the browser handle external links natively
                return;
              }

              if (
                href.endsWith(".md") &&
                (href.startsWith("./") || href.startsWith("../"))
              ) {
                e.preventDefault();
                if (onNavigate) {
                  onNavigate(href);
                }
              }
            };

            return (
              <a
                {...props}
                href={href}
                onClick={handleClick}
                target={href?.startsWith("http") ? "_blank" : undefined}
                rel={
                  href?.startsWith("http") ? "noopener noreferrer" : undefined
                }
              >
                {children}
              </a>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
};
