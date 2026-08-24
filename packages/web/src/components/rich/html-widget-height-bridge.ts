import { WIDGET_PROOF_REQUEST_MESSAGE, WIDGET_SIZE_MESSAGE } from './html-widget-layout-machine';

export { WIDGET_SIZE_MESSAGE } from './html-widget-layout-machine';

function escapeInlineScriptValue(value: string): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

export function addHtmlWidgetHeightBridge(html: string, blockId: string, instanceId: string): string {
  const bridge = `<style data-cat-cafe-widget-bridge>html,body{overflow: hidden !important;}</style>
<script data-cat-cafe-widget-bridge>(() => {
  const messageType = ${escapeInlineScriptValue(WIDGET_SIZE_MESSAGE)};
  const proofRequestType = ${escapeInlineScriptValue(WIDGET_PROOF_REQUEST_MESSAGE)};
  const blockId = ${escapeInlineScriptValue(blockId)};
  const instanceId = ${escapeInlineScriptValue(instanceId)};
  let scheduled = false;
  let lastSample = '';
  let pendingCause = null;
  let lastMeasuredViewportHeight = null;
  let lastMeasuredViewportWidth = null;
  let pendingProofRequestId = null;
  const observedElements = new WeakSet();
  let resizeObserver = null;
  const postPending = (cause) => {
    if (pendingCause === 'content' || pendingCause === cause) return;
    pendingCause = cause;
    parent.postMessage({ type: messageType, v: 6, phase: 'pending', cause, blockId, instanceId }, '*');
  };
  const hasPendingResources = () => {
    const imagePending = Array.from(document.images).some((image) => !image.complete);
    const mediaPending = Array.from(document.querySelectorAll('video[src],audio[src]'))
      .some((media) => media.readyState < 1);
    const stylesheetPending = Array.from(document.querySelectorAll('link[rel~="stylesheet"][href]'))
      .some((link) => !link.sheet);
    return [imagePending, mediaPending, stylesheetPending, document.fonts?.status === 'loading'].some(Boolean);
  };
  const observeLayoutTree = () => {
    if (!resizeObserver) return;
    if (!document.body) return;
    for (const element of [document.documentElement, document.body, ...document.body.querySelectorAll('*')]) {
      if (observedElements.has(element)) continue;
      observedElements.add(element);
      resizeObserver.observe(element);
    }
  };
  const hasUnmeasurableVisualOverflow = () => {
    const body = document.body;
    const elements = [document.documentElement, ...(body ? [body, ...body.querySelectorAll('*')] : [])];
    return elements.some((element) =>
      ['::before', '::after'].some((pseudo) => {
        const style = getComputedStyle(element, pseudo);
        const generated = style.content !== 'none' && style.content !== 'normal' && style.display !== 'none';
        return generated && style.position === 'fixed';
      })
    );
  };
  const measure = () => {
    scheduled = false;
    observeLayoutTree();
    if (hasPendingResources()) return;
    const body = document.body;
    let contentBottom = 0;
    // Root/body boxes inherit the iframe viewport floor for common height:100% CSS.
    // Measure rendered content descendants in document coordinates so the parent
    // actuator is not mistaken for intrinsic content height.
    const includeRect = (rect) => {
      if (rect.width > 0 || rect.height > 0) contentBottom = Math.max(contentBottom, rect.bottom + window.scrollY);
    };
    body?.querySelectorAll('*').forEach((element) => {
      if (element.closest('[data-cat-cafe-widget-bridge]')) return;
      for (const rect of element.getClientRects()) includeRect(rect);
    });
    if (body) {
      const textWalker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
      let textNode = textWalker.nextNode();
      while (textNode) {
        if (textNode.textContent?.trim()) {
          const range = document.createRange();
          range.selectNodeContents(textNode);
          for (const rect of range.getClientRects()) includeRect(rect);
          range.detach();
        }
        textNode = textWalker.nextNode();
      }
    }
    const contentHeight = Math.max(1, Math.ceil(contentBottom));
    // Body and root scroll extents cover different generated boxes. Both may
    // also equal the iframe viewport floor, so the parent keeps their proof
    // sources separate instead of collapsing them into one maximum here.
    const bodyScrollHeight = Math.max(1, Math.ceil(body?.scrollHeight ?? contentHeight));
    const rootScrollHeight = Math.max(1, Math.ceil(document.documentElement.scrollHeight));
    const unmeasurableVisualOverflow = hasUnmeasurableVisualOverflow();
    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;
    const sample = [
      contentHeight,
      bodyScrollHeight,
      rootScrollHeight,
      unmeasurableVisualOverflow,
      viewportHeight,
      viewportWidth
    ].join(':');
    const sampleChanged = lastSample !== '' && sample !== lastSample;
    if (pendingProofRequestId !== null && sampleChanged && pendingCause === null) postPending('content');
    if (sample !== lastSample || pendingCause !== null || pendingProofRequestId !== null) {
      const proofRequestId = pendingProofRequestId;
      pendingProofRequestId = null;
      lastSample = sample;
      pendingCause = null;
      lastMeasuredViewportHeight = viewportHeight;
      lastMeasuredViewportWidth = viewportWidth;
      parent.postMessage({
        type: messageType,
        v: 6,
        phase: 'measured',
        blockId,
        instanceId,
        contentHeight,
        bodyScrollHeight,
        rootScrollHeight,
        hasUnmeasurableVisualOverflow: unmeasurableVisualOverflow,
        viewportHeight,
        viewportWidth,
        ...(proofRequestId === null ? {} : { proofRequestId })
      }, '*');
    }
  };
  const schedule = (cause) => {
    postPending(cause);
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => requestAnimationFrame(measure));
  };
  const scheduleContent = () => schedule('content');
  const scheduleViewport = () => schedule('viewport');
  const resizeCause = () =>
    lastMeasuredViewportHeight !== null &&
    (Math.abs(window.innerHeight - lastMeasuredViewportHeight) > 0 ||
      Math.abs(window.innerWidth - lastMeasuredViewportWidth) > 0)
      ? 'viewport'
      : 'content';
  resizeObserver =
    typeof ResizeObserver === 'function' ? new ResizeObserver(() => schedule(resizeCause())) : null;
  window.addEventListener('load', scheduleContent);
  window.addEventListener('resize', scheduleViewport);
  window.addEventListener('message', (event) => {
    if (event.source !== parent || !event.data || typeof event.data !== 'object') return;
    const request = event.data;
    const proofRequestId = request.proofRequestId;
    if (
      request.type !== proofRequestType ||
      request.v !== 6 ||
      request.blockId !== blockId ||
      request.instanceId !== instanceId ||
      typeof proofRequestId !== 'string' ||
      proofRequestId.length < 1 ||
      proofRequestId.length > 128 ||
      !/^[A-Za-z0-9:_-]+$/.test(proofRequestId)
    ) return;
    pendingProofRequestId = proofRequestId;
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => requestAnimationFrame(measure));
  });
  document.addEventListener('load', scheduleContent, true);
  document.addEventListener('error', scheduleContent, true);
  document.addEventListener('DOMContentLoaded', () => {
    observeLayoutTree();
    scheduleContent();
  }, { once: true });
  new MutationObserver(() => {
    observeLayoutTree();
    scheduleContent();
  }).observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true
  });
  document.fonts?.addEventListener?.('loading', scheduleContent);
  document.fonts?.addEventListener?.('loadingdone', scheduleContent);
  document.fonts?.addEventListener?.('loadingerror', scheduleContent);
  document.fonts?.ready.then(scheduleContent).catch(() => {});
  observeLayoutTree();
  scheduleContent();
})();</script>`;

  return html.includes('</head>') ? html.replace('</head>', `${bridge}</head>`) : `${bridge}${html}`;
}
