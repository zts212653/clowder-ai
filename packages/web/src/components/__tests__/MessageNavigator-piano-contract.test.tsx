import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/stores/chat-types';
import { MessageNavigator } from '../MessageNavigator';

const ownerData = vi.hoisted(() => ({ getCatById: () => undefined, coCreator: { name: 'Owner' } }));
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ getCatById: ownerData.getCatById }) }));
vi.mock('@/hooks/useCoCreatorConfig', () => ({ useCoCreatorConfig: () => ownerData.coCreator }));
vi.mock('../shell/shell-presentation', () => ({ useShellPresentation: () => 'v2' }));

function rectangle(top: number, height: number): DOMRect {
  return { top, bottom: top + height, height, left: 0, right: 400, width: 400, x: 0, y: top, toJSON: () => ({}) };
}

describe('v2 piano uses every visible loaded row', () => {
  let host: HTMLDivElement;
  let viewport: HTMLDivElement;
  let root: Root;
  const jump = vi.fn(() => true);
  const begin = vi.fn(() => null);
  const previousReact = (globalThis as { React?: typeof React }).React;
  const actEnvironment = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');

  beforeEach(() => {
    Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
    vi.clearAllMocks();
    host = document.createElement('div');
    viewport = document.createElement('div');
    viewport.dataset.chatContainer = '';
    viewport.getBoundingClientRect = () => rectangle(100, 600);
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 600 });
    document.body.append(host, viewport);
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return host.contains(this) ? rectangle(100, 600) : originalRect.call(this);
    });
    const originalHeight = Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight')?.get;
    vi.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(function (this: Element): number {
      if (host.contains(this)) return 600;
      const value: unknown = originalHeight?.call(this);
      return typeof value === 'number' ? value : 0;
    });
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.restoreAllMocks();
    host.remove();
    viewport.remove();
    Object.assign(globalThis, { React: previousReact });
    if (actEnvironment) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', actEnvironment);
    else delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  function renderRows(
    count: number,
    collapsedIndex = -1,
    customize?: (message: ChatMessage, row: HTMLDivElement, index: number) => void,
  ) {
    let offset = 60; // Header is real scroll content, not the first message.
    const messages: ChatMessage[] = Array.from({ length: count }, (_, index) => {
      const message: ChatMessage = {
        id: `row-${index}`,
        type: 'assistant',
        catId: 'opus',
        content: `Loaded row ${index}`,
        timestamp: index,
      };
      const row = document.createElement('div');
      row.dataset.messageViewportId = message.id;
      row.dataset.messageViewportBoundary = '';
      const rowTop = offset;
      const height = index === collapsedIndex ? 0 : index % 3 === 0 ? 480 : 60;
      row.getBoundingClientRect = () => rectangle(100 + rowTop - viewport.scrollTop, height);
      if (height > 0) row.textContent = message.content;
      customize?.(message, row, index);
      viewport.append(row);
      offset += height;
      return message;
    });
    Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: offset + 80 });
    act(() =>
      root.render(
        <MessageNavigator
          messages={messages}
          scrollContainerRef={{ current: viewport }}
          onJumpToMessage={jump}
          beginUserScroll={begin}
        />,
      ),
    );
  }

  it.each([24, 240, 900])('retains all %i loaded message targets instead of sampling eighteen', (count) => {
    renderRows(count);
    const targets = host.querySelectorAll('[role="option"], button[aria-label^="跳转到"]');
    expect(targets).toHaveLength(count);
    expect(
      [...host.querySelectorAll<HTMLElement>('[data-message-piano-key]')].map(
        (element) => element.dataset.messagePianoKey,
      ),
    ).toEqual(Array.from({ length: count }, (_, index) => `row-${index}`));
  });

  it('keeps a collapsed carrier anchor but omits its zero-height key', () => {
    renderRows(24, 7);
    expect(viewport.querySelector('[data-message-viewport-id="row-7"]')).not.toBeNull();
    expect(host.querySelectorAll('[role="option"], button[aria-label^="跳转到"]')).toHaveLength(23);
    expect(host.querySelector('[data-message-piano-key="row-7"]')).toBeNull();
  });

  it('scrolls a long history without measuring every row or reformatting every label', () => {
    let scheduled: FrameRequestCallback | undefined;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      scheduled = callback;
      return 1;
    });
    let rowMeasurements = 0;
    const labels = vi.spyOn(Date.prototype, 'toLocaleString');
    renderRows(240, -1, (_message, row) => {
      const measure = row.getBoundingClientRect;
      row.getBoundingClientRect = () => {
        rowMeasurements += 1;
        return measure();
      };
    });
    const thumb = host.querySelector<HTMLElement>('[data-message-piano-thumb]');
    const initialTop = Number.parseFloat(thumb?.style.top ?? '0');
    rowMeasurements = 0;
    labels.mockClear();
    act(() => {
      viewport.scrollTop = 600;
      viewport.dispatchEvent(new Event('scroll'));
      scheduled?.(1);
    });
    expect(Number.parseFloat(thumb?.style.top ?? '0')).toBeGreaterThan(initialTop);
    expect(host.querySelectorAll('[data-message-piano-key]')).toHaveLength(240);
    expect(rowMeasurements, 'unchanged content positions are independent of the scroll offset').toBe(0);
    expect(labels, 'static accessible labels do not change when the thumb moves').not.toHaveBeenCalled();
  });

  it('redraws late layout geometry without scrolling or mounting deferred message bodies', () => {
    let resize: ResizeObserverCallback | undefined;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          resize = callback;
        }
        observe() {}
        disconnect() {}
        unobserve() {}
      },
    );
    let scheduled: FrameRequestCallback | undefined;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      scheduled = callback;
      return 1;
    });
    viewport.scrollTop = 123;
    renderRows(24);
    const first = host.querySelector<HTMLElement>('[data-message-piano-key="row-0"]');
    const oldHeight = Number.parseFloat(first?.style.height ?? '0');
    const originalContentHeight = viewport.scrollHeight;
    const rows = [...viewport.querySelectorAll<HTMLElement>('[data-message-viewport-id]')];
    for (const [index, row] of rows.entries()) {
      const old = row.getBoundingClientRect();
      row.getBoundingClientRect = () =>
        rectangle(old.top + (index === 0 ? 0 : 150), old.height + (index === 0 ? 150 : 0));
      row.dataset.deferredMessageId = row.dataset.messageViewportId;
    }
    Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: originalContentHeight + 150 });
    act(() => {
      resize?.([], {} as ResizeObserver);
      scheduled?.(1);
    });
    expect(Number.parseFloat(first?.style.height ?? '0')).toBeGreaterThan(oldHeight);
    expect(viewport.scrollTop).toBe(123);
    expect(viewport.querySelectorAll('[data-deferred-message-id]')).toHaveLength(24);
    expect(jump).not.toHaveBeenCalled();
    expect(begin).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('uses neutral human keys and consumes only owner-provided error and interaction signals', () => {
    renderRows(24, -1, (message, row, index) => {
      if (index === 0) {
        message.type = 'user';
        delete message.catId;
      }
      if (index === 1) {
        message.variant = 'error';
        row.dataset.messageNavigationError = 'true';
      }
      if (index === 2) {
        const block = document.createElement('div');
        block.dataset.messageNavigationResponse = 'interactive';
        row.append(block);
      }
      if (index === 3) {
        message.content = 'Error: a historical narrative, with no owner signal';
        row.textContent = message.content;
      }
    });
    const human = host.querySelector<HTMLElement>('[data-message-piano-key="row-0"] > div');
    expect(human?.style.backgroundColor).toBe('var(--cafe-text-muted)');
    expect(host.querySelector('[data-message-piano-key="row-1"]')?.getAttribute('data-message-piano-error')).toBe(
      'true',
    );
    expect(host.querySelector('[data-message-piano-key="row-2"]')?.getAttribute('data-message-piano-response')).toBe(
      'true',
    );
    expect(host.querySelector('[data-message-piano-key="row-3"]')?.hasAttribute('data-message-piano-error')).toBe(
      false,
    );
  });

  it('provides one Tab stop for the track while keeping every row addressable', () => {
    renderRows(24);
    const stops = [...host.querySelectorAll<HTMLElement>('button, [tabindex]')].filter(
      (element) => element.tabIndex >= 0,
    );
    expect(stops).toHaveLength(1);
    expect(stops[0].getAttribute('role')).toBe('listbox');
  });
});
