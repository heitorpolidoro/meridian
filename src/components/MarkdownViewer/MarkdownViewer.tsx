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
export const MarkdownViewer: React.FC<MarkdownViewerProps> = ({
  content = "",
  onNavigate,
}) => {
  return (
    <div className="markdown-viewer">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          /**
           * Custom renderer for code blocks and inline code with syntax highlighting.
           *
           * @param {unknown} node - The AST node for the code element.
           * @param {boolean} inline - Whether the code is inline.
           * @param {string} className - CSS class name indicating the language.
           * @param {React.ReactNode[]} children - The code content as React nodes.
           * @param {Object} props - Additional props passed to the code element.
           * @returns {React.ReactNode} The rendered code block or inline code element.
           */
          code({
            inline,
            className,
            children,
            ...props
          }: Record<string, unknown>) {
            const match = /language-(\w+)/.exec((className as string) || "");
            const lang = match ? match[1] : "";
            // Basic language support list, fallback to text
            const isSupported = [
              "typescript",
              "ts",
              "tsx",
              "javascript",
              "json",
              "bash",
              "markdown",
              "css",
              "html",
            ].includes(lang);

            const content = React.Children.toArray(children)
              .join("")
              .replace(/\n$/, "");

            return !inline && (isSupported || match) ? (
              <SyntaxHighlighter
                {...props}
                style={vscDarkPlus as Record<string, React.CSSProperties>}
                language={isSupported ? lang : "text"}
                PreTag="div"
              >
                {content}
              </SyntaxHighlighter>
            ) : (
              <code {...props} className={className as string}>
                {children as React.ReactNode}
              </code>
            );
          },
          /**
           * Render a link element for Markdown-rendered content.
           *
           * @param node The Markdown AST node.
           * @param href The hyperlink reference.
           * @param children The content to display within the link.
           * @param props Additional anchor element props.
           * @returns The rendered anchor element.
           */
          a({ node, href, children, ...props }: Record<string, unknown>) {
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
