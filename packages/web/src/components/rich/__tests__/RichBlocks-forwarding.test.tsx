import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/TransferTargetPicker', async () => {
  const { createElement } = await vi.importActual<typeof import('react')>('react');
  return {
    TransferTargetPicker: ({ open, items }: { open: boolean; items: unknown[] }) =>
      open
        ? createElement('output', {
            'data-testid': 'rich-forward-picker-probe',
            'data-items': JSON.stringify(items),
          })
        : null,
  };
});

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

  it('opens the shared picker with only the selected block identity and source-record refs', () => {
    React.act(() => {
      root.render(
        <RichBlocks
          blocks={[
            { id: 'card-1', kind: 'card', v: 1, title: 'Decision', bodyMarkdown: 'Use exact refs.' },
            { id: 'card-2', kind: 'card', v: 1, title: 'Sibling', bodyMarkdown: 'Do not forward me.' },
          ]}
          messageId="source-anchor"
          sourceThreadId="source-thread"
          sourceMessageIds={['source-stream', 'source-anchor']}
        />,
      );
    });

    React.act(() => container.querySelector<HTMLButtonElement>('button[aria-label="转发富块：Decision"]')?.click());

    const probe = container.querySelector<HTMLOutputElement>('[data-testid="rich-forward-picker-probe"]');
    expect(JSON.parse(probe?.dataset.items ?? '[]')).toEqual([
      {
        kind: 'rich_block',
        messageId: 'source-anchor',
        sourceMessageIds: ['source-stream', 'source-anchor'],
        blockId: 'card-1',
      },
    ]);
  });

  it('keeps individually addressable forwarding actions for blocks inside an interactive group', () => {
    React.act(() => {
      root.render(
        <RichBlocks
          blocks={[
            {
              id: 'choice-1',
              kind: 'interactive',
              v: 1,
              groupId: 'decisions',
              interactiveType: 'select',
              title: 'First decision',
              options: [{ id: 'a', label: 'A' }],
            },
            {
              id: 'choice-2',
              kind: 'interactive',
              v: 1,
              groupId: 'decisions',
              interactiveType: 'select',
              title: 'Second decision',
              options: [{ id: 'b', label: 'B' }],
            },
          ]}
          messageId="source-anchor"
          sourceThreadId="source-thread"
          sourceMessageIds={['source-anchor']}
        />,
      );
    });

    const second = container.querySelector<HTMLButtonElement>('button[aria-label="转发富块：Second decision"]');
    expect(second).not.toBeNull();
    React.act(() => second?.click());

    const probe = container.querySelector<HTMLOutputElement>('[data-testid="rich-forward-picker-probe"]');
    expect(JSON.parse(probe?.dataset.items ?? '[]')).toEqual([
      {
        kind: 'rich_block',
        messageId: 'source-anchor',
        sourceMessageIds: ['source-anchor'],
        blockId: 'choice-2',
      },
    ]);
  });

  it('does not offer Rich Block forwarding while the canonical source group is streaming', () => {
    React.act(() => {
      root.render(
        <RichBlocks
          blocks={[{ id: 'card-live', kind: 'card', v: 1, title: 'Still streaming' }]}
          messageId="source-anchor"
          sourceThreadId="source-thread"
          sourceMessageIds={['source-anchor']}
          forwardingEnabled={false}
        />,
      );
    });

    expect(container.querySelector('button[aria-label="转发富块：Still streaming"]')).toBeNull();
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
