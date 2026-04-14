import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import './MarkdownViewer.css';

interface MarkdownViewerProps {
  content?: string;
  onNavigate?: (path: string) => void;
}

export const MarkdownViewer: React.FC<MarkdownViewerProps> = ({ content = '', onNavigate }) => {
  return (
    <div className="markdown-viewer">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ node, inline, className, children, ...props }: any) {
            const match = /language-(\w+)/.exec(className || '');
            const lang = match ? match[1] : '';
            // Basic language support list, fallback to text
            const isSupported = ['typescript', 'ts', 'tsx', 'javascript', 'json', 'bash', 'markdown', 'css', 'html'].includes(lang);
            
            return !inline && (isSupported || match) ? (
              <SyntaxHighlighter
                {...props}
                style={vscDarkPlus}
                language={isSupported ? lang : 'text'}
                PreTag="div"
              >
                {String(children).replace(/\n$/, '')}
              </SyntaxHighlighter>
            ) : (
              <code {...props} className={className}>
                {children}
              </code>
            );
          },
          a({ node, href, children, ...props }: any) {
            const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
              if (!href) return;
              
              if (href.startsWith('http')) {
                // Let the browser handle external links natively
                return;
              }
              
              if (href.endsWith('.md') && (href.startsWith('./') || href.startsWith('../'))) {
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
                target={href?.startsWith('http') ? '_blank' : undefined}
                rel={href?.startsWith('http') ? 'noopener noreferrer' : undefined}
              >
                {children}
              </a>
            );
          }
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
};
