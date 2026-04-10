import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import './MarkdownViewer.css';

interface MarkdownViewerProps {
  content?: string;
}

const DEFAULT_CONTENT = '# Initial Markdown\n\n- [ ] Task 1\n- [x] Task 2\n\n| Column 1 | Column 2 |\n| -------- | -------- |\n| Value 1  | Value 2  |';

export const MarkdownViewer: React.FC<MarkdownViewerProps> = ({ content = DEFAULT_CONTENT }) => {
  return (
    <div className="markdown-viewer">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>
        {content}
      </ReactMarkdown>
    </div>
  );
};
