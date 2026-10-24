import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const { RichBlocks } = await import('../RichBlocks');

describe('RichBlocks exact forwarding', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    React.act(() => root.unmount());
    container.remove();
  });

  it('keeps cards readable without a second forwarding entry', () => {
    React.act(() =>
      root.render(
        <RichBlocks
          blocks={[{ id: 'card-1', kind: 'card', v: 1, title: 'Decision', bodyMarkdown: 'Use exact refs.' }]}
          messageId="source-anchor"
          sourceThreadId="source-thread"
        />,
      ),
    );
    expect(container.textContent).toContain('Decision');
    expect(container.querySelector('[data-testid="rich-block-forward-actions"]')).toBeNull();
    expect(container.querySelector('button[title="单独转发这个富块"]')).toBeNull();
  });

  it('renders action-bearing card, interactive, and HTML blocks passively in read-only mode', () => {
    React.act(() => {
      root.render(
        <RichBlocks
          readOnly
          blocks={[
            {
              id: 'card-1',
              kind: 'card',
              v: 1,
              title: 'Approval',
              actions: [{ label: 'Approve now', action: 'approve', payload: { callbackToken: 'secret' } }],
              meta: { kind: 'proposal', callbackToken: 'secret' },
            },
            {
              id: 'choice-1',
              kind: 'interactive',
              v: 1,
              interactiveType: 'select',
              title: 'Choose one',
              options: [{ id: 'x', label: 'Run callback', action: { type: 'callback', endpoint: '/api/run' } }],
            },
            { id: 'html-1', kind: 'html_widget', v: 1, title: 'Widget', html: '<script>run()</script>' },
          ]}
        />,
      );
    });

    expect(container.textContent).toContain('Approval');
    expect(container.textContent).toContain('Choose one');
    expect(container.textContent).toContain('Run callback');
    expect(container.textContent).toContain('Widget');
    expect(container.querySelector('iframe')).toBeNull();
    expect(
      Array.from(container.querySelectorAll('button')).some((button) => button.textContent?.includes('Approve')),
    ).toBe(false);
    expect(
      Array.from(container.querySelectorAll('button')).some((button) => button.textContent?.includes('Run callback')),
    ).toBe(false);
  });
});
