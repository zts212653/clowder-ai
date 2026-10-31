import type { ContextAttachment } from '@cat-cafe/shared';
import React, { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatInput } from '../ChatInput';

const mockSend = vi.fn(async () => true);
const mockInput = vi.fn((props: ComponentProps<typeof ChatInput>) => props);
vi.mock('@/hooks/useSendMessage', () => ({
  useSendMessage: () => ({ handleSend: mockSend, uploadStatus: 'idle', uploadError: null }),
}));
vi.mock('../ChatInput', () => ({
  ChatInput: (props: ComponentProps<typeof ChatInput>) => {
    mockInput(props);
    return null;
  },
}));
vi.mock('../MiniThreadSidebar', () => ({ MiniThreadSidebar: () => null }));
vi.mock('../SplitPaneCell', () => ({ SplitPaneCell: () => null, SplitPanePlaceholder: () => null }));

import { useChatStore } from '@/stores/chatStore';
import { SplitPaneChatView } from '../SplitPaneView';

describe('shared split composer admission', () => {
  const original = useChatStore.getState();
  let container: HTMLDivElement;
  let root: Root;
  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  beforeEach(() => {
    vi.clearAllMocks();
    useChatStore.setState({ threads: [], splitPaneThreadIds: [], splitPaneTargetId: 'split-target' });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(React.createElement(SplitPaneChatView, { onZoomToThread: vi.fn() })));
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useChatStore.setState({
      threads: original.threads,
      splitPaneThreadIds: original.splitPaneThreadIds,
      splitPaneTargetId: original.splitPaneTargetId,
    });
  });
  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('keeps the selected split composer writable until readonly is explicitly required', () => {
    expect(mockInput.mock.calls.at(-1)?.[0].disabled).toBe(false);
    act(() => root.render(React.createElement(SplitPaneChatView, { isReadonly: true, onZoomToThread: vi.fn() })));
    expect(mockInput.mock.calls.at(-1)?.[0].disabled).toBe(true);
    act(() => {
      useChatStore.setState({ splitPaneTargetId: null });
      root.render(React.createElement(SplitPaneChatView, { isReadonly: false, onZoomToThread: vi.fn() }));
    });
    expect(mockInput.mock.calls.at(-1)?.[0].disabled).toBe(true);
  });

  it.each([false, true])('opts its selected thread into consumption (attachments=%s)', async (withAttachments) => {
    const attachments: ContextAttachment[] = [
      {
        v: 1,
        id: 'quote-1',
        kind: 'quote',
        text: '原文',
        source: { kind: 'workspace_file', path: 'docs/a.md', revision: `sha256:${'a'.repeat(64)}` },
      },
    ];
    const onSend = mockInput.mock.calls[0][0].onSend;
    await act(async () => {
      await onSend('消息', undefined, undefined, 'reply-1', withAttachments ? attachments : undefined);
    });
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0]).toEqual([
      '消息',
      undefined,
      'split-target',
      undefined,
      'reply-1',
      withAttachments ? attachments : undefined,
      undefined,
      { consumeComposerDraft: true },
    ]);
  });
});
