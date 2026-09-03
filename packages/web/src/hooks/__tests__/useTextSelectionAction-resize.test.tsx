import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTextSelectionAction } from '../useTextSelectionAction';

interface ObserverHarness {
  callback: ResizeObserverCallback;
  observed: Element[];
  disconnected: boolean;
}

const observers: ObserverHarness[] = [];

class MockResizeObserver implements ResizeObserver {
  readonly harness: ObserverHarness;

  constructor(callback: ResizeObserverCallback) {
    this.harness = { callback, observed: [], disconnected: false };
    observers.push(this.harness);
  }

  observe(target: Element) {
    this.harness.observed.push(target);
  }

  unobserve(target: Element) {
    this.harness.observed = this.harness.observed.filter((element) => element !== target);
  }

  disconnect() {
    this.harness.disconnected = true;
  }
}

function HookHost() {
  const containerRef = useRef<HTMLDivElement>(null);
  const action = useTextSelectionAction(containerRef, true, 'message-1', 'viewport');
  return (
    <div>
      <div ref={containerRef} data-testid="selection-container">
        <span data-context-quote-source="message" data-testid="selected-source">
          selected text
        </span>
        <span data-context-quote-source="message" data-testid="unrelated-source">
          unrelated text
        </span>
      </div>
      <output data-testid="selection-position">
        {action ? `${action.position.top}:${action.position.left}` : 'none'}
      </output>
    </div>
  );
}

describe('useTextSelectionAction container resize', () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalResizeObserver: typeof globalThis.ResizeObserver;
  let selectionRect: DOMRect;
  let intersectedNodes: Node[];

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = MockResizeObserver;
  });

  afterAll(() => {
    globalThis.ResizeObserver = originalResizeObserver;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    observers.length = 0;
    selectionRect = new DOMRect(200, 200, 100, 20);
    intersectedNodes = [];

    vi.spyOn(window, 'getSelection').mockImplementation(() => {
      const selectionContainer = container.querySelector('[data-testid="selection-container"]');
      const textNode = container.querySelector('[data-testid="selected-source"]')?.firstChild ?? null;
      if (!selectionContainer || !textNode) return null;

      const range = document.createRange();
      range.selectNodeContents(textNode);
      const nativeIntersectsNode = range.intersectsNode.bind(range);
      Object.defineProperties(range, {
        getBoundingClientRect: { value: () => selectionRect },
        getClientRects: { value: () => [selectionRect] },
        intersectsNode: {
          value: (node: Node) => {
            intersectedNodes.push(node);
            return nativeIntersectsNode(node);
          },
        },
      });

      return {
        anchorNode: textNode,
        focusNode: textNode,
        getRangeAt: () => range,
        isCollapsed: false,
        rangeCount: 1,
        toString: () => range.toString(),
      } as unknown as Selection;
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it('reprojects the floating action when pane reflow resizes its container', async () => {
    await act(async () => root.render(<HookHost />));

    const selectionContainer = container.querySelector('[data-testid="selection-container"]');
    expect(selectionContainer).not.toBeNull();
    expect(container.querySelector('[data-testid="selection-position"]')?.textContent).toBe('160:188');
    expect(observers).toHaveLength(1);
    expect(observers[0]?.observed).toEqual([selectionContainer]);
    expect(intersectedNodes).not.toContain(container.querySelector('[data-testid="unrelated-source"]'));

    selectionRect = new DOMRect(400, 300, 100, 20);
    await act(async () => {
      observers[0]?.callback([{ target: selectionContainer } as ResizeObserverEntry], {} as ResizeObserver);
    });

    expect(container.querySelector('[data-testid="selection-position"]')?.textContent).toBe('260:388');
  });
});
