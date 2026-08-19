import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceToolbarButton } from '../WorkspaceToolbarButton';

describe('WorkspaceToolbarButton', () => {
  it('does not impose listen-specific flex layout on existing toolbar buttons', () => {
    const html = renderToStaticMarkup(
      <WorkspaceToolbarButton onClick={vi.fn()} title="Copy">
        Copy
      </WorkspaceToolbarButton>,
    );

    expect(html).not.toContain('flex-shrink-0');
    expect(html).not.toContain('whitespace-nowrap');
    expect(html).not.toContain('gap-1');
    expect(html).not.toMatch(/class="[^"]*\bflex\b/);
  });
});
