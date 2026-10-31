import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsRow } from '../SettingsRow';

Object.assign(globalThis as Record<string, unknown>, { React });

const LONG_TITLE = 'Memory semantic recall with a deliberately long provider and model identity';
const LONG_META =
  '这段设置说明会在窄屏占据多行；发生真实溢出时必须出现展开全文，且中文、emoji 👨‍👩‍👧‍👦 与组合字符 e\u0301 都要原样保留。';
const resizeCallbacks = new Set<ResizeObserverCallback>();

class MockResizeObserver implements ResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    resizeCallbacks.add(callback);
  }

  disconnect() {}
  observe() {}
  unobserve() {}
}

function setSize(
  element: Element,
  size: Record<'clientWidth' | 'scrollWidth' | 'clientHeight' | 'scrollHeight', number>,
) {
  for (const [key, value] of Object.entries(size)) {
    Object.defineProperty(element, key, { configurable: true, value });
  }
}

async function notifyResize(element: Element) {
  await act(async () => {
    for (const callback of resizeCallbacks) {
      callback([{ target: element } as ResizeObserverEntry], {} as ResizeObserver);
    }
  });
}

describe('SettingsRow recoverable overflow', () => {
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

  it('gives long string title and prose explicit recovery without triggering the parent row', async () => {
    const onClick = vi.fn();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });

    await act(async () => root.render(<SettingsRow title={LONG_TITLE} meta={LONG_META} onClick={onClick} />));

    const title = container.querySelector('[data-overflow-measure="inline"]');
    const prose = container.querySelector('[data-overflow-measure="block"]');
    expect(title).not.toBeNull();
    expect(prose).not.toBeNull();
    if (!title || !prose) return;

    setSize(title, { clientWidth: 100, scrollWidth: 480, clientHeight: 20, scrollHeight: 20 });
    setSize(prose, { clientWidth: 240, scrollWidth: 240, clientHeight: 40, scrollHeight: 120 });
    await notifyResize(title);
    await notifyResize(prose);

    const copy = container.querySelector<HTMLButtonElement>('button[aria-label="复制完整设置标题"]');
    const expand = container.querySelector<HTMLButtonElement>('button[aria-expanded="false"][aria-controls]');
    expect(copy).not.toBeNull();
    expect(expand?.textContent).toContain('展开全文');

    await act(async () => copy?.click());
    expect(writeText).toHaveBeenCalledWith(LONG_TITLE);
    expect(onClick).not.toHaveBeenCalled();

    await act(async () => expand?.click());
    expect(onClick).not.toHaveBeenCalled();
    expect(container.textContent).toContain('👨‍👩‍👧‍👦');
    expect(container.textContent).toContain('e\u0301');
  });

  it('never silently clips structured metadata it cannot safely convert to prose', async () => {
    await act(async () =>
      root.render(
        <SettingsRow
          title="结构化成员信息"
          meta={
            <span data-testid="structured-meta">
              <strong>别名：</strong>小太阳 · 砚砚 · Sol
            </span>
          }
        />,
      ),
    );

    const structured = container.querySelector('[data-testid="structured-meta"]');
    expect(structured).not.toBeNull();
    expect(structured?.closest('.truncate')).toBeNull();
    expect(container.textContent).toContain('小太阳 · 砚砚 · Sol');
  });
});
