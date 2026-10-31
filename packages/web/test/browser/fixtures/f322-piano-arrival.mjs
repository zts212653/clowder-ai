// Read-only native-frame observations; never scroll, mount rows or change classes.
export function observePianoArrival({ id, savedKey }) {
  const samples = [];
  const tokens = new WeakMap();
  let nextToken = 0;
  const start = performance.now();
  window.pianoArrivalTrace = { id, samples };
  const sample = () => {
    const chat = document.querySelector('[data-chat-container]');
    const target = chat?.querySelector(`[data-message-id="${id}"]`);
    const box = target?.getBoundingClientRect();
    const view = chat?.getBoundingClientRect();
    if (target && !tokens.has(target)) tokens.set(target, ++nextToken);
    samples.push({
      time: performance.now() - start,
      nodeToken: target ? tokens.get(target) : null,
      connected: target?.isConnected ?? false,
      matches: chat?.querySelectorAll(`[data-message-id="${id}"]`).length ?? 0,
      highlighted: target?.dataset.messageJumpFocus === 'true',
      visible: !!box && !!view && box.bottom > view.top && box.top < view.bottom,
      top: box?.top,
      bottom: box?.bottom,
      viewportTop: view?.top,
      viewportBottom: view?.bottom,
      scrollTop: chat?.scrollTop,
      contentHeight: chat?.scrollHeight,
      deferred: chat?.querySelectorAll('[data-deferred-message-id]').length,
      saved: JSON.parse(localStorage.getItem(savedKey) || 'null')?.state,
    });
    if (performance.now() - start < 4000) requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
}
