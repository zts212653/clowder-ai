import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RichFileBlock } from '@/stores/chat-types';
import { FileBlock } from '../FileBlock';

Object.assign(globalThis as Record<string, unknown>, { React });

const LONG_FILE_NAME = 'F269-全前端长文本审计-包含中文与家庭emoji-👨‍👩‍👧‍👦-最终复核报告.pdf';
const resizeCallbacks = new Set<ResizeObserverCallback>();

class MockResizeObserver implements ResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    resizeCallbacks.add(callback);
  }

  disconnect() {}
  observe() {}
  unobserve() {}
}

function setInlineSize(element: Element, clientWidth: number, scrollWidth: number) {
  Object.defineProperty(element, 'clientWidth', { configurable: true, value: clientWidth });
  Object.defineProperty(element, 'scrollWidth', { configurable: true, value: scrollWidth });
}

async function notifyResize(element: Element) {
  await act(async () => {
    for (const callback of resizeCallbacks) {
      callback([{ target: element } as ResizeObserverEntry], {} as ResizeObserver);
    }
  });
}

function fileBlock(overrides: Partial<RichFileBlock> = {}): RichFileBlock {
  return {
    id: 'f269-file',
    kind: 'file',
    v: 1,
    url: '/uploads/f269-report.pdf',
    fileName: LONG_FILE_NAME,
    mimeType: 'application/pdf',
    fileSize: 8_388_608,
    ...overrides,
  };
}

describe('FileBlock recoverable overflow', () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalResizeObserver: typeof globalThis.ResizeObserver;

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
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    resizeCallbacks.clear();
    vi.restoreAllMocks();
  });

  it('keeps a full long filename recoverable without nesting the copy action inside the download link', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });

    await act(async () => root.render(<FileBlock block={fileBlock()} />));

    const measured = container.querySelector('[data-overflow-measure="inline"]');
    expect(measured).not.toBeNull();
    if (!measured) return;

    setInlineSize(measured, 120, 620);
    await notifyResize(measured);

    const copy = container.querySelector<HTMLButtonElement>('button[aria-label="复制完整文件名"]');
    expect(copy).not.toBeNull();
    expect(container.querySelector('a button')).toBeNull();
    expect(container.querySelector('[role="tooltip"]')?.textContent).toBe(LONG_FILE_NAME);

    const download = container.querySelector<HTMLAnchorElement>('a[download]');
    expect(download?.getAttribute('href')).toBe('/uploads/f269-report.pdf');
    expect(download?.getAttribute('download')).toBe(LONG_FILE_NAME);

    await act(async () => copy?.click());
    expect(writeText).toHaveBeenCalledWith(LONG_FILE_NAME);
  });

  it('uses the same recoverable filename contract for inline video attachments', async () => {
    await act(async () =>
      root.render(
        <FileBlock
          block={fileBlock({
            id: 'f269-video',
            url: '/uploads/f269-walkthrough.mp4',
            fileName: `${LONG_FILE_NAME}.mp4`,
            mimeType: 'video/mp4',
          })}
        />,
      ),
    );

    expect(container.querySelector('video')).not.toBeNull();
    expect(container.querySelector('[data-overflow-measure="inline"]')?.textContent).toContain(LONG_FILE_NAME);
    expect(container.querySelector('.truncate')).toBeNull();
  });
});
