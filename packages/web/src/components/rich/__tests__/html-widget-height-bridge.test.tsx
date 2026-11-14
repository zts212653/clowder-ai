import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { addHtmlWidgetHeightBridge } from '../html-widget-height-bridge';

function measureFixture({ visualBottom = 214, viewportBody = false } = {}) {
  document.documentElement.style.cssText = 'margin:0;padding:0;border:0';
  document.body.style.cssText = 'margin:0;padding:14px;border:0';
  document.body.innerHTML = '<main></main>';
  const content = document.querySelector('main');
  if (!content) throw new Error('missing fixture content');
  const rect = new DOMRect(0, 14, 100, visualBottom - 14);
  vi.spyOn(content, 'getClientRects').mockReturnValue(Object.assign([rect], { item: () => rect }));
  const bodyHeight = viewportBody ? 500 : 228;
  vi.spyOn(document.body, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 100, bodyHeight));
  vi.spyOn(document.documentElement, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 100, bodyHeight));
  const frames: Array<() => void> = [];
  const messages: Array<Record<string, unknown>> = [];
  const html = addHtmlWidgetHeightBridge('<main></main>', 'box-edges', 'instance');
  const script = html.match(/<script data-cat-cafe-widget-bridge>([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error('missing generated bridge');
  runInNewContext(script, {
    document: {
      body: document.body,
      documentElement: document.documentElement,
      images: [],
      querySelectorAll: document.querySelectorAll.bind(document),
      createTreeWalker: document.createTreeWalker.bind(document),
      addEventListener() {},
    },
    window: { innerHeight: 500, innerWidth: 100, scrollY: 0, addEventListener() {}, setTimeout() {} },
    parent: { postMessage: (message: Record<string, unknown>) => messages.push(message) },
    performance: { now: () => 0 },
    NodeFilter,
    getComputedStyle: (element: Element, pseudo?: string) => (pseudo ? { content: 'none' } : getComputedStyle(element)),
    requestAnimationFrame: (callback: () => void) => frames.push(callback),
    MutationObserver: class {
      observe() {}
    },
  });
  while (frames.length > 0) frames.shift()?.();
  return messages.find((message) => message.phase === 'measured');
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
  document.body.removeAttribute('style');
  document.documentElement.removeAttribute('style');
});

describe('height bridge trailing box edges', () => {
  it('includes the body trailing padding for ordinary flow content', () => {
    expect(measureFixture()?.contentHeight).toBe(228);
  });

  it('still measures intrinsic content when body height follows the viewport', () => {
    expect(measureFixture({ viewportBody: true })?.contentHeight).toBe(228);
  });

  it('does not append flow padding to visual overflow outside the body content box', () => {
    expect(measureFixture({ visualBottom: 400 })?.contentHeight).toBe(400);
  });

  it('does not turn a viewport-bottom fixed element into growing overflow', () => {
    expect(measureFixture({ visualBottom: 500, viewportBody: true })?.contentHeight).toBe(500);
  });
});
