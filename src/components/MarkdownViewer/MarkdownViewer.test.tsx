import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { MarkdownViewer } from './MarkdownViewer';

describe('MarkdownViewer', () => {
  it('renders a hardcoded string when no content is provided', () => {
    render(<MarkdownViewer />);
    expect(screen.getByText('Initial Markdown')).toBeInTheDocument();
  });

  it('renders provided markdown content', () => {
    const testContent = '# Test Heading\n\n- Test List Item';
    render(<MarkdownViewer content={testContent} />);
    expect(screen.getByRole('heading', { name: /test heading/i })).toBeInTheDocument();
    expect(screen.getByText('Test List Item')).toBeInTheDocument();
  });

  it('renders GFM elements (tables)', () => {
    const tableContent = '| Col 1 | Col 2 |\n|-------|-------|\n| Val 1 | Val 2 |';
    render(<MarkdownViewer content={tableContent} />);
    const table = screen.getByRole('table');
    expect(table).toBeInTheDocument();
    expect(screen.getByText('Col 1')).toBeInTheDocument();
    expect(screen.getByText('Val 1')).toBeInTheDocument();
  });

  it('renders GFM elements (task lists)', () => {
    const taskContent = '- [ ] Incomplete Task\n- [x] Completed Task';
    render(<MarkdownViewer content={taskContent} />);
    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes).toHaveLength(2);
    expect(checkboxes[0]).not.toBeChecked();
    expect(checkboxes[1]).toBeChecked();
    expect(screen.getByText('Incomplete Task')).toBeInTheDocument();
    expect(screen.getByText('Completed Task')).toBeInTheDocument();
  });

  it('renders nothing when content is empty string', () => {
    const { container } = render(<MarkdownViewer content="" />);
    expect(container.querySelector('.markdown-viewer')?.innerHTML).toBe('');
  });
});
