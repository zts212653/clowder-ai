import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompactLabel } from '../CompactLabel';
import { CriticalText } from '../CriticalText';
import { ExpandableProse } from '../ExpandableProse';
import { LongFormReader } from '../LongFormReader';

Object.assign(globalThis as Record<string, unknown>, { React });

const COMPLEX_TEXT = '猫咖审计：中文不靠空格分词，家庭 emoji 👨‍👩‍👧‍👦 与组合字符 e\u0301 都必须完整保留。';

const resizeCallbacks = new Set<ResizeObserverCallback>();

class MockResizeObserver implements ResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    resizeCallbacks.add(callback);
  }

  disconnect() {}
  observe() {}
  unobserve() {}
}

function setElementSize(
  element: Element,
  size: { clientWidth?: number; scrollWidth?: number; clientHeight?: number; scrollHeight?: number },
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

function requireElement<T extends Element>(element: T | null): T {
  expect(element).not.toBeNull();
  if (!element) throw new Error('Expected element to exist');
  return element;
}

describe('recoverable content overflow primitives', () => {
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

  it('renders measured primitives on the server without layout-effect hydration warnings', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    renderToString(<CompactLabel label="文件名" value={COMPLEX_TEXT} />);

    expect(consoleError.mock.calls.flat().join(' ')).not.toContain('useLayoutEffect does nothing on the server');
  });

  it('keeps compact labels quiet until the value really overflows, then exposes the full value to focus and copy', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });

    await act(async () => {
      root.render(<CompactLabel label="文件名" value={COMPLEX_TEXT} />);
    });

    const measured = requireElement(container.querySelector('[data-overflow-measure="inline"]'));
    setElementSize(measured, { clientWidth: 240, scrollWidth: 240 });
    await notifyResize(measured);
    expect(container.querySelector('button')).toBeNull();

    setElementSize(measured, { clientWidth: 120, scrollWidth: 460 });
    await notifyResize(measured);

    const copy = container.querySelector<HTMLButtonElement>('button[aria-label="复制完整文件名"]');
    expect(copy).not.toBeNull();
    expect(copy?.tagName).toBe('BUTTON');
    expect(container.querySelector('[role="tooltip"]')?.textContent).toBe(COMPLEX_TEXT);

    await act(async () => copy?.click());
    expect(writeText).toHaveBeenCalledWith(COMPLEX_TEXT);
    expect(container.textContent).toContain('已复制');
  });

  it('shows an explicit prose disclosure only for measured overflow and preserves every grapheme', async () => {
    await act(async () => {
      root.render(<ExpandableProse text={COMPLEX_TEXT} lines={2} />);
    });

    const prose = requireElement(container.querySelector('[data-overflow-measure="block"]'));
    setElementSize(prose, { clientHeight: 40, scrollHeight: 124 });
    await notifyResize(prose);

    const toggle = container.querySelector<HTMLButtonElement>('button[aria-expanded="false"]');
    expect(toggle?.textContent).toContain('展开全文');
    expect(toggle?.getAttribute('aria-controls')).toBeTruthy();
    expect(prose?.textContent).toBe(COMPLEX_TEXT);

    await act(async () => toggle?.click());
    const collapse = container.querySelector<HTMLButtonElement>('button[aria-expanded="true"]');
    expect(collapse?.textContent).toContain('收起');
    expect(prose?.getAttribute('style')).not.toContain('-webkit-line-clamp');
    expect(prose?.textContent).toContain('👨‍👩‍👧‍👦');
    expect(prose?.textContent).toContain('e\u0301');
  });

  it('isolates compact-copy and prose-disclosure actions from clickable parent surfaces', async () => {
    const parentClick = vi.fn();
    await act(async () => {
      root.render(
        // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: models a clickable parent card around nested recovery controls
        <div onClick={parentClick}>
          <CompactLabel label="Feature 名称" value={COMPLEX_TEXT} />
          <ExpandableProse text={COMPLEX_TEXT} lines={2} />
        </div>,
      );
    });

    const compact = requireElement(container.querySelector('[data-overflow-measure="inline"]'));
    const prose = requireElement(container.querySelector('[data-overflow-measure="block"]'));
    setElementSize(compact, { clientWidth: 100, scrollWidth: 460 });
    setElementSize(prose, { clientHeight: 40, scrollHeight: 124 });
    await notifyResize(compact);
    await notifyResize(prose);

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="复制完整Feature 名称"]')?.click();
      container.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')?.click();
    });

    expect(parentClick).not.toHaveBeenCalled();
  });

  it('opens long-form content in a searchable reader with copy, source, Escape close, and focus restoration', async () => {
    const content = `# 完整报告\n\n${COMPLEX_TEXT}\n\n第二处猫咖命中。`;
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });

    await act(async () => {
      root.render(
        <LongFormReader
          title="Overflow Ledger 结论"
          summary="完整报告包含审计结论、证据和迁移建议。"
          content={content}
          format="markdown"
          source={{ label: 'F269 Feature', href: '/workspace/docs/features/F269-recoverable-content-overflow.md' }}
        />,
      );
    });

    const trigger = container.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]');
    expect(trigger?.textContent).toContain('阅读全文');
    await act(async () => trigger?.click());

    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]');
    expect(dialog?.textContent).toContain(COMPLEX_TEXT);
    expect(dialog?.className).toContain('overflow-x-hidden');
    expect(
      dialog?.querySelector('a[href="/workspace/docs/features/F269-recoverable-content-overflow.md"]'),
    ).not.toBeNull();

    const search = dialog?.querySelector<HTMLInputElement>('input[type="search"]');
    await act(async () => {
      if (search) {
        search.value = '猫咖';
        search.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    expect(dialog?.textContent).toContain('2 处匹配');

    const copy = dialog?.querySelector<HTMLButtonElement>('button[aria-label="复制完整内容"]');
    await act(async () => copy?.click());
    expect(writeText).toHaveBeenCalledWith(content);

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.body.querySelector('[role="dialog"][aria-modal="true"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('keeps compact readers at two lines and opens a bounded reading layer without bubbling row actions', async () => {
    const parentClick = vi.fn();
    const parentKeyDown = vi.fn();

    await act(async () => {
      root.render(
        // biome-ignore lint/a11y/noStaticElementInteractions: models a dense interactive row around the recovery control
        <div onClick={parentClick} onKeyDown={parentKeyDown}>
          <LongFormReader
            title="排队消息全文"
            summary={COMPLEX_TEXT}
            content={COMPLEX_TEXT}
            format="markdown"
            density="compact"
          />
        </div>,
      );
    });

    const summary = requireElement(container.querySelector<HTMLElement>('[data-overflow-measure="block"]'));
    expect(summary.style.webkitLineClamp).toBe('2');
    expect(container.querySelector('button[aria-haspopup="dialog"]')).toBeNull();

    setElementSize(summary, { clientHeight: 40, scrollHeight: 124 });
    await notifyResize(summary);

    const trigger = requireElement(container.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]'));
    expect(trigger.textContent).toContain('查看全文');
    expect(trigger.className).not.toContain('bg-cafe-accent');
    expect(trigger.tagName).toBe('BUTTON');
    expect(trigger.type).toBe('button');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    const dialogId = trigger.getAttribute('aria-controls');
    expect(dialogId).toBeTruthy();

    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    const space = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    trigger.dispatchEvent(enter);
    trigger.dispatchEvent(space);

    expect(parentClick).not.toHaveBeenCalled();
    expect(parentKeyDown).not.toHaveBeenCalled();
    expect(enter.defaultPrevented).toBe(false);
    expect(space.defaultPrevented).toBe(false);

    // jsdom does not synthesize the native click that real buttons receive from
    // Enter/Space. The semantic button + non-cancelled key events own that
    // browser behavior; click verifies the shared activation path.
    await act(async () => trigger.click());

    const dialog = requireElement(document.body.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]'));
    expect(dialog.id).toBe(dialogId);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(dialog.className).toContain('max-h-[calc(100dvh-24px)]');
    expect(dialog.querySelector('article')?.className).toContain('overflow-y-auto');
    expect(dialog.textContent).toContain('👨‍👩‍👧‍👦');
    expect(summary.style.webkitLineClamp).toBe('2');

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
  });

  it('keeps the reader trigger mounted for focus return when resize removes the overflow', async () => {
    await act(async () => {
      root.render(
        <LongFormReader title="排队消息全文" summary={COMPLEX_TEXT} content={COMPLEX_TEXT} density="compact" />,
      );
    });

    const summary = requireElement(container.querySelector<HTMLElement>('[data-overflow-measure="block"]'));
    setElementSize(summary, { clientHeight: 40, scrollHeight: 124 });
    await notifyResize(summary);

    const trigger = requireElement(container.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]'));
    await act(async () => trigger.click());
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();

    setElementSize(summary, { clientHeight: 40, scrollHeight: 40 });
    await notifyResize(summary);
    expect(container.contains(trigger)).toBe(true);

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('never silently clamps critical text and keeps technical details behind a prominent disclosure', async () => {
    await act(async () => {
      root.render(
        <CriticalText summary="保存失败：凭据校验没有通过。" details={`HTTP 401 · ${COMPLEX_TEXT}`} tone="critical" />,
      );
    });

    expect(container.textContent).toContain('保存失败：凭据校验没有通过。');
    expect(container.querySelector('[data-overflow-measure]')).toBeNull();
    expect(container.querySelector('[data-critical-text-appearance="inline"]')).not.toBeNull();
    expect(container.querySelector('[data-critical-text-appearance="inline"]')?.className).not.toContain('rounded-xl');
    expect(container.querySelector('[data-critical-text-appearance="inline"]')?.className).not.toContain('px-4');

    const details = container.querySelector<HTMLButtonElement>('button[aria-expanded="false"]');
    expect(details?.textContent).toContain('查看技术详情');
    await act(async () => details?.click());

    expect(container.querySelector('button[aria-expanded="true"]')?.textContent).toContain('收起技术详情');
    expect(container.textContent).toContain(`HTTP 401 · ${COMPLEX_TEXT}`);
  });

  it('only renders a standalone diagnostic panel when the caller explicitly opts in', async () => {
    await act(async () => {
      root.render(<CriticalText summary="同步被阻塞" details="完整诊断" tone="warning" appearance="panel" />);
    });

    const panel = requireElement(container.querySelector('[data-critical-text-appearance="panel"]'));
    expect(panel.className).toContain('rounded-xl');
    expect(panel.className).toContain('border');
    expect(panel.className).toContain('px-4');
  });

  it('isolates the critical-text disclosure from clickable parent surfaces', async () => {
    const parentClick = vi.fn();
    const parentKeyDown = vi.fn();
    await act(async () => {
      root.render(
        // biome-ignore lint/a11y/noStaticElementInteractions: models a clickable parent card around a nested recovery control
        <div onClick={parentClick} onKeyDown={parentKeyDown}>
          <CriticalText summary="运行失败" details={COMPLEX_TEXT} />
        </div>,
      );
    });

    const disclosure = container.querySelector<HTMLButtonElement>('button[aria-expanded="false"]');
    await act(async () => disclosure?.click());
    disclosure?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(parentClick).not.toHaveBeenCalled();
    expect(parentKeyDown).not.toHaveBeenCalled();
  });
});
