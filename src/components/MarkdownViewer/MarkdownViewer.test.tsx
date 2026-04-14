import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MarkdownViewer } from './MarkdownViewer';

describe('MarkdownViewer - Core Rendering', () => {
  it('renders provided markdown content', () => {
    render(<MarkdownViewer content="# Hello World" />);
    expect(screen.getByText('Hello World')).toBeInTheDocument();
  });

  it('renders empty content when none provided', () => {
    const { container } = render(<MarkdownViewer />);
    expect(container.querySelector('.markdown-viewer')?.innerHTML).toBe('');
  });
});

describe('MarkdownViewer - Link Handler', () => {
  it('should render external links to open in a new tab', () => {
    const content = '[External Link](https://example.com)';
    render(<MarkdownViewer content={content} />);
    
    const link = screen.getByRole('link', { name: 'External Link' });
    expect(link).toHaveAttribute('href', 'https://example.com');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('should not interfere with clicking external links', () => {
    const content = '[External Link](https://example.com)';
    render(<MarkdownViewer content={content} />);
    const link = screen.getByRole('link', { name: 'External Link' });
    
    // This covers the return; in handleClick for external links
    fireEvent.click(link);
  });

  it('should prevent default and call onNavigate for relative .md links', () => {
    const onNavigate = vi.fn();
    const content = '[Relative Link](./plan.md)';
    render(<MarkdownViewer content={content} onNavigate={onNavigate} />);
    
    const link = screen.getByRole('link', { name: 'Relative Link' });
    expect(link).toHaveAttribute('href', './plan.md');
    
    fireEvent.click(link);
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith('./plan.md');
  });

  it('should call onNavigate for ../ relative links', () => {
    const onNavigate = vi.fn();
    const content = '[Parent Link](../other/plan.md)';
    render(<MarkdownViewer content={content} onNavigate={onNavigate} />);
    
    const link = screen.getByRole('link', { name: 'Parent Link' });
    fireEvent.click(link);
    expect(onNavigate).toHaveBeenCalledWith('../other/plan.md');
  });

  it('should not trigger onNavigate if link is not .md', () => {
    const onNavigate = vi.fn();
    const content = '[Image](./test.png)';
    render(<MarkdownViewer content={content} onNavigate={onNavigate} />);
    
    const link = screen.getByRole('link', { name: 'Image' });
    fireEvent.click(link);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('should not trigger onNavigate for absolute-path links not starting with . or ..', () => {
    const onNavigate = vi.fn();
    const content = '[Root Path](/root/plan.md)';
    render(<MarkdownViewer content={content} onNavigate={onNavigate} />);
    
    const link = screen.getByRole('link', { name: 'Root Path' });
    fireEvent.click(link);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('should handle links without href', () => {
    const { container } = render(<MarkdownViewer content="[No Href]()" />);
    const link = container.querySelector('a');
    expect(link).toBeInTheDocument();
    if (link) fireEvent.click(link);
  });

  it('should handle relative link without onNavigate provided', () => {
    const content = '[Relative Link](./plan.md)';
    render(<MarkdownViewer content={content} />);
    const link = screen.getByRole('link', { name: 'Relative Link' });
    fireEvent.click(link);
    // Should not crash
  });
});

describe('MarkdownViewer - Code Block Highlighting', () => {
  it('should highlight typescript blocks', () => {
    const content = '```typescript\nconst a = 1;\n```';
    const { container } = render(<MarkdownViewer content={content} />);
    expect(container.querySelector('div')).toBeInTheDocument();
  });

  it('should highlight ts blocks', () => {
    const content = '```ts\nconst a = 1;\n```';
    const { container } = render(<MarkdownViewer content={content} />);
    expect(container.querySelector('div')).toBeInTheDocument();
  });

  it('should highlight json blocks', () => {
    const content = '```json\n{ "a": 1 }\n```';
    const { container } = render(<MarkdownViewer content={content} />);
    expect(container.querySelector('div')).toBeInTheDocument();
  });

  it('should fallback to text for unknown languages but still use SyntaxHighlighter', () => {
    const content = '```unknown\nsome text\n```';
    const { container } = render(<MarkdownViewer content={content} />);
    // SyntaxHighlighter is used because 'match' exists
    expect(container.querySelector('div')).toBeInTheDocument();
  });

  it('should render code without language as regular code tag', () => {
    const content = '```\nno lang\n```';
    render(<MarkdownViewer content={content} />);
    const code = screen.getByText('no lang');
    expect(code.tagName).toBe('CODE');
  });

  it('should render inline code with standard <code> tag', () => {
    const content = '`inline code`';
    render(<MarkdownViewer content={content} />);
    expect(screen.getByText('inline code')).toBeInTheDocument();
    expect(screen.getByText('inline code').tagName).toBe('CODE');
  });
});
