import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThreadItem } from '../ThreadItem';

vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    getCatById: () => null,
    cats: [],
  }),
}));

describe('ThreadItem hover tooltip (#36)', () => {
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
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('shows summary as title attribute when provided', () => {
    act(() => {
      root.render(
        React.createElement(ThreadItem, {
          id: 'thread-1',
          title: 'Test thread',
          participants: [],
          lastActiveAt: Date.now(),
          isActive: false,
          onSelect: vi.fn(),
          summary: 'This is the thread summary text',
        }),
      );
    });

    const item = container.querySelector('[title="This is the thread summary text"]');
    expect(item).not.toBeNull();
  });

  it('does not set title attribute when summary is absent', () => {
    act(() => {
      root.render(
        React.createElement(ThreadItem, {
          id: 'thread-2',
          title: 'Another thread',
          participants: [],
          lastActiveAt: Date.now(),
          isActive: false,
          onSelect: vi.fn(),
        }),
      );
    });

    // The outer div should not have a title attribute (except on action buttons)
    const outerDiv = container.firstElementChild;
    expect(outerDiv).not.toBeNull();
    expect(outerDiv?.getAttribute('title')).toBeNull();
  });
});
