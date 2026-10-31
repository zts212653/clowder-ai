// Observe the painted frame and native hit targets; no event is dispatched to a chosen DOM node.
export function pianoThumbHitTest() {
  const thumb = document.querySelector('[data-message-piano-thumb]');
  const rect = thumb.getBoundingClientRect();
  const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  const points = [
    [0, 0],
    [-0.25, 0],
    [0.25, 0],
    [0, -0.25],
    [0, 0.25],
  ].map(([x, y]) => {
    const target = document.elementFromPoint(center.x + x * rect.width, center.y + y * rect.height);
    const drag = target?.closest('[data-message-piano-thumb], [data-message-piano-grab]');
    return {
      x: center.x + x * rect.width,
      y: center.y + y * rect.height,
      tag: target?.tagName,
      key: target?.closest('[data-message-piano-key]')?.getAttribute('data-message-piano-key'),
      dragTarget: !!drag && getComputedStyle(drag).pointerEvents !== 'none',
    };
  });
  return { thumb: rect.toJSON(), center, points };
}

export function observePianoPointerOwnership() {
  const track = document.querySelector('[data-message-piano]');
  const chat = document.querySelector('[data-chat-container]');
  const trace = { pointerDown: [], highlightAdded: [] };
  window.pianoPointerOwnership = trace;
  const down = (event) =>
    trace.pointerDown.push({
      target: event.target.closest('[data-message-piano-thumb], [data-message-piano-grab]')?.getAttribute('class'),
      captured: track.hasPointerCapture(event.pointerId),
    });
  const observer = new MutationObserver((changes) => {
    for (const change of changes) {
      if (change.oldValue !== 'true' && change.target.dataset.messageJumpFocus === 'true')
        trace.highlightAdded.push(change.target.getAttribute('data-message-id'));
    }
  });
  document.addEventListener('pointerdown', down);
  observer.observe(chat, {
    subtree: true,
    attributes: true,
    attributeFilter: ['data-message-jump-focus'],
    attributeOldValue: true,
  });
  window.stopPianoPointerOwnership = () => {
    observer.disconnect();
    document.removeEventListener('pointerdown', down);
  };
}

export function measurePianoPage(settleCount) {
  const chat = document.querySelector('[data-chat-container]');
  const track = document.querySelector('[data-message-piano]');
  const view = chat.getBoundingClientRect(),
    ruler = track?.getBoundingClientRect();
  const rows = [...chat.querySelectorAll('[data-message-viewport-id]')].map((row) => {
    const rect = row.getBoundingClientRect();
    return { id: row.dataset.messageViewportId, top: rect.top - view.top + chat.scrollTop, height: rect.height };
  });
  const keys = [...document.querySelectorAll('[data-message-piano-key]')].map((key) => {
    const rect = key.getBoundingClientRect();
    return {
      id: key.dataset.messagePianoKey,
      top: rect.top - ruler.top,
      height: rect.height,
      left: rect.left,
      right: rect.right,
      color: getComputedStyle(key.firstElementChild).backgroundColor,
      tabIndex: key.tabIndex,
    };
  });
  const thumb = document.querySelector('[data-message-piano-thumb]')?.getBoundingClientRect();
  const measurement = {
    theme: document.documentElement.dataset.theme,
    mode: document.documentElement.dataset.shell,
    paneWidth: document.querySelector('[data-piano-host]').getBoundingClientRect().width,
    contentHeight: chat.scrollHeight,
    viewportHeight: chat.clientHeight,
    top: chat.scrollTop,
    trackHeight: ruler?.height,
    trackLeft: ruler?.left,
    viewportRight: view.right,
    scrollbar: getComputedStyle(chat).scrollbarWidth,
    rows,
    keys,
    thumbHeight: thumb?.height,
    thumbTop: thumb ? thumb.top - ruler.top : null,
    deferred: chat.querySelectorAll('[data-deferred-message-id]').length,
    draft: document.querySelector('textarea')?.value,
    saved: JSON.parse(localStorage.getItem('cat-cafe:thread-scroll:composer-proof-0') || 'null'),
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    contentRight: Math.max(
      ...[...chat.querySelectorAll('[data-message-id]')].map((row) => row.getBoundingClientRect().right),
    ),
    tabStops: track ? [...track.querySelectorAll('[tabindex]'), track].filter((el) => el.tabIndex === 0).length : 0,
  };
  if (typeof settleCount === 'number') {
    // Return the frame that actually passed readiness, not a boolean followed
    // by a separate measurement after deferred rows or ResizeObserver repaint.
    const matches =
      rows.length === settleCount &&
      keys.length === settleCount &&
      keys.every(
        (key, index) =>
          key.id === rows[index].id &&
          Math.abs(key.top - (rows[index].top / measurement.contentHeight) * measurement.trackHeight) < 1,
      );
    const fingerprint = JSON.stringify({
      height: measurement.contentHeight,
      viewport: measurement.viewportHeight,
      top: measurement.top,
      rows: rows.map(({ id, top }) => ({ id, top })),
      keys: keys.map(({ id, top }) => ({ id, top })),
    });
    const previous = window.pianoRulerObservation;
    window.pianoRulerObservation = { matches, fingerprint };
    if (!matches || !previous?.matches || previous.fingerprint !== fingerprint) return false;
  }
  return measurement;
}
