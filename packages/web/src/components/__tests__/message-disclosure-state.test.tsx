import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CollapsibleMarkdown } from '../CollapsibleMarkdown';
import { CliOutputBlock } from '../cli-output/CliOutputBlock';
import { buildMessageDisclosureKey, resetMessageDisclosureStateForTest } from '../message-disclosure-state';
import { ThinkingContent } from '../ThinkingContent';

const LONG_MESSAGE = Array.from({ length: 30 }, (_, index) => `line ${index}`).join('\n');

describe('message disclosure state', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    resetMessageDisclosureStateForTest();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    window.history.replaceState(null, '', '/');
  });

  it('renders the complete long message without disclosure chrome in export mode', () => {
    window.history.replaceState(null, '', '/thread/thread-A?export=true&messageId=message-A');

    act(() => {
      root.render(<CollapsibleMarkdown content={LONG_MESSAGE} disclosureKey="thread-A:message-A:body" />);
    });

    expect(container.querySelector('button')).toBeNull();
    expect(container.textContent).toContain('line 29');
    expect(container.querySelector<HTMLElement>('.overflow-hidden')?.style.maxHeight).toBeFalsy();
  });

  it('keeps an explicit expansion when the message subtree unmounts and remounts', () => {
    const disclosureKey = 'thread-A:turn-A:body';

    act(() => {
      root.render(<CollapsibleMarkdown content={LONG_MESSAGE} disclosureKey={disclosureKey} />);
    });
    const showMore = container.querySelector('button');
    expect(showMore?.textContent).toContain('Show more');

    act(() => showMore?.click());
    expect(container.querySelector('button')?.textContent).toBe('Show less');

    act(() => root.render(<div>temporarily unmounted</div>));
    act(() => {
      root.render(<CollapsibleMarkdown content={LONG_MESSAGE} disclosureKey={disclosureKey} />);
    });

    expect(container.querySelector('button')?.textContent).toBe('Show less');
  });

  it('uses the stable per-turn identity across draft-to-canonical message id replacement', () => {
    const draft = {
      id: 'draft-message-id',
      type: 'assistant' as const,
      catId: 'codex-sol',
      content: 'draft',
      timestamp: 1,
      extra: { stream: { invocationId: 'parent-A', turnInvocationId: 'turn-A' } },
    };
    const canonical = {
      ...draft,
      id: 'canonical-message-id',
      content: 'canonical',
    };

    expect(buildMessageDisclosureKey('thread-A', draft, 'body')).toBe(
      buildMessageDisclosureKey('thread-A', canonical, 'body'),
    );
  });

  it('uses the server message id for separate explicit posts under the same turn', () => {
    const first = {
      id: 'srv-speech-1',
      type: 'assistant' as const,
      catId: 'sonnet',
      content: 'first',
      timestamp: 1,
      extra: {
        isExplicitPost: true,
        stream: { invocationId: 'parent-A', turnInvocationId: 'turn-A' },
      },
    };
    const second = {
      ...first,
      id: 'srv-speech-2',
      content: 'second',
    };

    expect(buildMessageDisclosureKey('thread-A', first, 'body')).not.toBe(
      buildMessageDisclosureKey('thread-A', second, 'body'),
    );
  });

  it('keeps separate explicit posts independently expanded', () => {
    const first = {
      id: 'srv-speech-1',
      type: 'assistant' as const,
      catId: 'sonnet',
      content: LONG_MESSAGE,
      timestamp: 1,
      extra: {
        isExplicitPost: true,
        stream: { invocationId: 'parent-A', turnInvocationId: 'turn-A' },
      },
    };
    const second = {
      ...first,
      id: 'srv-speech-2',
    };

    act(() => {
      root.render(
        <>
          <CollapsibleMarkdown
            content={LONG_MESSAGE}
            disclosureKey={buildMessageDisclosureKey('thread-A', first, 'body')}
          />
          <CollapsibleMarkdown
            content={LONG_MESSAGE}
            disclosureKey={buildMessageDisclosureKey('thread-A', second, 'body')}
          />
        </>,
      );
    });

    const buttons = container.querySelectorAll('button');
    expect(buttons).toHaveLength(2);
    act(() => buttons[0]?.click());
    expect(buttons[0]?.textContent).toBe('Show less');
    expect(buttons[1]?.textContent).toContain('Show more');
  });

  it('keeps an explicit thinking-panel expansion across remount', () => {
    const props = {
      content: 'private reasoning',
      disclosureKey: 'thread-A:turn-A:thinking',
      expandInExport: false,
    };

    act(() => root.render(<ThinkingContent {...props} />));
    expect(container.querySelector('button')?.textContent).toContain('private reasoning');

    act(() => container.querySelector('button')?.click());
    expect(container.querySelector('button')?.textContent).not.toContain('private reasoning');

    act(() => root.render(<div>temporarily unmounted</div>));
    act(() => root.render(<ThinkingContent {...props} />));
    expect(container.querySelector('button')?.textContent).not.toContain('private reasoning');
  });

  it('keeps an explicit CLI-panel expansion across remount', () => {
    const props = {
      events: [{ id: 'text-1', kind: 'text' as const, timestamp: 1, content: 'command output' }],
      status: 'done' as const,
      disclosureKey: 'thread-A:turn-A:cli',
    };

    act(() => root.render(<CliOutputBlock {...props} />));
    expect(container.querySelector('[data-testid="cli-output-body"]')).toBeNull();

    act(() => container.querySelector('button')?.click());
    expect(container.querySelector('[data-testid="cli-output-body"]')).not.toBeNull();

    act(() => root.render(<div>temporarily unmounted</div>));
    act(() => root.render(<CliOutputBlock {...props} />));
    expect(container.querySelector('[data-testid="cli-output-body"]')).not.toBeNull();
  });
});
