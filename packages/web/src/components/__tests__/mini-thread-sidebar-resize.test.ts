// @vitest-environment jsdom
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MiniThreadSidebar } from '@/components/MiniThreadSidebar';

beforeAll(() => {
  (globalThis as { React?: typeof React }).React = React;
});
afterAll(() => {
  delete (globalThis as { React?: typeof React }).React;
});

vi.mock('@/stores/chatStore', () => ({
  useChatStore: () => ({
    threads: [
      { id: 't1', title: 'Thread 1', participants: ['opus'] },
      { id: 't2', title: 'Thread 2', participants: ['codex'] },
    ],
    splitPaneThreadIds: ['t1'],
    getThreadState: () => ({ catStatuses: {}, unreadCount: 0 }),
  }),
}));

vi.mock('@/components/ThreadCatStatus', () => ({
  getCatStatusType: () => 'idle',
}));

vi.mock('@/components/CatAvatar', () => ({
  CatAvatar: ({ catId }: { catId: string }) => React.createElement('span', null, catId),
}));

const origCreateElement = document.createElement.bind(document);
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = origCreateElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('MiniThreadSidebar resize cleanup', () => {
  it('removes document listeners when unmounted during drag', () => {
    const onAssign = vi.fn();

    act(() => {
      root.render(React.createElement(MiniThreadSidebar, { onAssignToPane: onAssign }));
    });

    // Find the drag handle (the last child of aside with cursor-col-resize)
    const aside = container.querySelector('aside');
    const handle = aside?.querySelector('.cursor-col-resize');
    expect(handle).toBeTruthy();

    // Track listener additions/removals
    const addSpy = vi.spyOn(document, 'addEventListener');
    const removeSpy = vi.spyOn(document, 'removeEventListener');

    // Start dragging
    act(() => {
      handle?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 100 }));
    });

    // Verify mousemove and mouseup were added
    const moveAdded = addSpy.mock.calls.some(([type]) => type === 'mousemove');
    const upAdded = addSpy.mock.calls.some(([type]) => type === 'mouseup');
    expect(moveAdded).toBe(true);
    expect(upAdded).toBe(true);

    // Get the exact listener references that were added
    const moveListener = addSpy.mock.calls.find(([type]) => type === 'mousemove')?.[1];
    const upListener = addSpy.mock.calls.find(([type]) => type === 'mouseup')?.[1];

    // Unmount WITHOUT triggering mouseup — simulates mode switch during drag
    act(() => root.unmount());

    // Check that cleanup removed the exact same listener references
    const removedMove = removeSpy.mock.calls.some(([type, fn]) => type === 'mousemove' && fn === moveListener);
    const removedUp = removeSpy.mock.calls.some(([type, fn]) => type === 'mouseup' && fn === upListener);

    expect(removedMove).toBe(true);
    expect(removedUp).toBe(true);

    addSpy.mockRestore();
    removeSpy.mockRestore();
  });
});
