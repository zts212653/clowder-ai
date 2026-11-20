const { resolve } = require('node:path');
const { createSurfacePartition, refuseSurfaceMedia } = require('./surface-partition.cjs');

/** F336 Phase C: the living cat's body window and its click lease.
 * - The window is a transparent, unfocusable layer over the primary work area. It ignores the
 *   mouse (forwarding moves, so he can watch your hand) unless the Host decides otherwise.
 * - The page reports where the cat is clickable with `body.hit {rects}` only when that changes,
 *   and keeps it alive with a repaint-independent `body.hit.renew`. Without a renewal for
 *   HIT_LEASE_MS the desktop is clickable again, so a hung page blocks clicks for at most 1.5 s.
 * - The Host bounds every region: at most 8 finite, positive rects wholly inside the body window
 *   and at most 15% of the work area in total; a violating update is refused whole.
 * - A press that landed on the region holds the body until mouse-up (Host-observed input), so a
 *   dragged paper ball can leave its old rect and still be released on the cat's layer. The hold
 *   lives only as long as the lease: a page that hangs mid-drag frees the desktop within 1.5 s too.
 * - He is on screen once his visible body rect (the anchor, in window coordinates) is one of the
 *   clickable rects: candidate.3 gives no ready signal, alpha.38 sends the anchor even with no atlas,
 *   and sends the paper ball's rect when only the ball's atlas loaded, but his own rect only for a
 *   drawn frame. That latches; hiding in the box later is not a failure (PR #7292 R1 P1-3; an
 *   explicit ready signal belongs to the next candidate).
 * - One cat at a time (F317): the window is transparent and takes no click until the Host reveals
 *   it, in the same step that hands the panel the living skin (the ball goes); a swap out conceals
 *   it first, before its scene is flushed. Rendering goes on while transparent, so he can draw.
 * - `body.anchor {rect}` reports the cat's visible body rect in body-window coordinates; the Host
 *   converts it to screen coordinates. A page can never name an absolute desktop position. */
const HIT_LEASE_MS = 1500;
const HIT_RECTS_MAX = 8;
const HIT_AREA_SHARE = 0.15;
const CAPTURE_MS = 15000;
const denied = (code) => ({ kind: 'error', code });
const ok = () => ({ kind: 'ok' });
const exactKeys = (value, keys) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join() === [...keys].sort().join();
const rectKeys = ['x', 'y', 'width', 'height'];
/** A finite, positive rect in body-window coordinates, wholly inside the window. */
const windowRect = (value, bounds) =>
  exactKeys(value, rectKeys) &&
  rectKeys.every((key) => Number.isFinite(value[key])) &&
  value.width > 0 &&
  value.height > 0 &&
  value.x >= 0 &&
  value.y >= 0 &&
  value.x + value.width <= bounds.width &&
  value.y + value.height <= bounds.height;

function createLivingBody({ win, generation, screen, now = Date.now }) {
  let rects;
  let revealed = false;
  let drawnAt; // his last anchor in window coordinates
  let shown = false;
  const sameRect = (a, b) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
  const notice = () => {
    shown ||= Boolean(drawnAt && rects?.some((rect) => sameRect(rect, drawnAt)));
  };
  let renewedAt = Number.NEGATIVE_INFINITY;
  let capture;
  let anchor;
  let ignored = true; // the factory default
  const contents = win.webContents; // a replaced body is released after the group destroyed it
  const area = () => screen.getDisplayMatching(win.getBounds()).workArea;
  const onRegion = (cursor) => {
    if (!rects || now() - renewedAt >= HIT_LEASE_MS) return false;
    const bounds = win.getBounds();
    const x = cursor.x - bounds.x;
    const y = cursor.y - bounds.y;
    return rects.some((r) => x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height);
  };
  const onInput = (_event, input) => {
    if (input?.type === 'mouseDown' && onRegion(screen.getCursorScreenPoint())) capture = { at: now() };
    else if (input?.type === 'mouseUp') capture = undefined;
  };
  contents.on('input-event', onInput);
  win.setOpacity(0);
  const setIgnored = (value) => {
    if (value === ignored || win.isDestroyed()) return;
    ignored = value;
    win.setIgnoreMouseEvents(value, { forward: true });
  };
  function hit(command) {
    const bounds = win.getBounds();
    const workArea = area();
    const list = command.rects;
    if (
      !exactKeys(command, ['kind', 'rects']) ||
      !Array.isArray(list) ||
      list.length > HIT_RECTS_MAX ||
      !list.every((rect) => windowRect(rect, bounds)) ||
      list.reduce((sum, rect) => sum + rect.width * rect.height, 0) > HIT_AREA_SHARE * workArea.width * workArea.height
    )
      return denied('invalid_request');
    rects = list.map(({ x, y, width, height }) => ({ x, y, width, height }));
    renewedAt = now();
    notice();
    return ok();
  }
  function renew(command) {
    if (!exactKeys(command, ['kind'])) return denied('invalid_request');
    if (rects) renewedAt = now();
    return ok();
  }
  function place(command) {
    const bounds = win.getBounds();
    const workArea = area();
    const rect = command.rect;
    if (
      !exactKeys(command, ['kind', 'rect']) ||
      !windowRect(rect, bounds) ||
      rect.width > workArea.width ||
      rect.height > workArea.height
    )
      return denied('invalid_request');
    drawnAt = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    notice();
    anchor = {
      x: Math.round(bounds.x + rect.x),
      y: Math.round(bounds.y + rect.y),
      width: Math.max(1, Math.round(rect.width)),
      height: Math.max(1, Math.round(rect.height)),
    };
    return ok();
  }
  return {
    generation,
    area,
    /** He has been drawn at least once: his body rect was among the clickable rects. */
    shown: () => shown,
    /** The cat's visible body rect in screen coordinates, once the body has reported it. */
    anchor: () => anchor && { ...anchor },
    request(command) {
      if (command.kind === 'body.hit') return hit(command);
      if (command.kind === 'body.hit.renew') return renew(command);
      if (command.kind === 'body.anchor') return place(command);
      return denied('invalid_request'); // body.menu is the pet window's, scene.* the scene writer's
    },
    /** One step of the shared 32 ms tick. An open panel under the cursor wins over the region;
     * a press that began on the region keeps the body until it is released or the lease lapses. */
    tick(cursor, overPanel) {
      if (win.isDestroyed()) return;
      const zoom = contents.getZoomFactor?.();
      if (zoom !== undefined && zoom !== 1) contents.setZoomFactor(1);
      const visible = win.isVisible();
      const leased = rects !== undefined && now() - renewedAt < HIT_LEASE_MS;
      if (!visible || !leased || (capture && now() - capture.at > CAPTURE_MS)) capture = undefined;
      setIgnored(!(visible && revealed && (capture !== undefined || (!overPanel && onRegion(cursor)))));
    },
    /** The panel has just been told the living skin: he is the cat on screen now. */
    reveal() {
      if (win.isDestroyed()) return;
      revealed = true;
      win.setOpacity(1);
    },
    /** A swap out begins: he leaves the screen before his scene is flushed and the window closes. */
    conceal() {
      revealed = false;
      capture = undefined;
      if (win.isDestroyed()) return;
      win.setOpacity(0);
      setIgnored(true);
    },
    /** Internal swap out or whole-cat close: nothing on this body is clickable any more. */
    release() {
      contents.removeListener('input-event', onInput);
      rects = undefined;
      capture = undefined;
      anchor = undefined;
      setIgnored(true);
    },
  };
}

/** Host → body page event over the same `companion:event` channel the preload subscribes to. */
function pushToBody(win, event) {
  if (!win.isDestroyed()) win.webContents.send('companion:event', event);
}

const DISPLAY_EVENTS = ['display-metrics-changed', 'display-added', 'display-removed'];
/** The body covers the primary work area: when it changes (Dock shown or hidden, resolution,
 * displays added or removed) the window takes the new bounds and the page is told its new size,
 * so it can re-map floor and walls, with how tall the cat stands. Electron's display events only;
 * no polling. */
function followPrimaryWorkArea({ screen, win, standHeight }) {
  const follow = () => {
    if (win.isDestroyed()) return;
    const { x, y, width, height } = screen.getPrimaryDisplay().workArea;
    const bounds = win.getBounds();
    if (bounds.x === x && bounds.y === y && bounds.width === width && bounds.height === height) return;
    win.setBounds({ x, y, width, height });
    pushToBody(win, { kind: 'body-area', width, height, ...(standHeight ? { standHeight: standHeight() } : {}) });
  };
  for (const name of DISPLAY_EVENTS) screen.on(name, follow);
  return () => {
    for (const name of DISPLAY_EVENTS) screen.removeListener(name, follow);
  };
}

/** The real body window. The URL is the package's verified body entry, chosen by the caller;
 * the window group shows it with showInactive, so it never takes keyboard focus. */
async function openBodyWindow({ BrowserWindow, session, screen }, { url, presentation }) {
  const partition = createSurfacePartition(session, url);
  refuseSurfaceMedia(partition);
  const { x, y, width, height } = screen.getPrimaryDisplay().workArea;
  const win = new BrowserWindow({
    title: '猫猫球',
    show: false,
    opacity: 0, // revealed by the Host when the panel lets the ball go
    frame: false,
    transparent: true,
    focusable: false,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: presentation.alwaysOnTop,
    skipTaskbar: presentation.skipTaskbar,
    x,
    y,
    width,
    height,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: resolve(__dirname, 'preload.cjs'),
      session: partition,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false,
      allowRunningInsecureContent: false,
      spellcheck: false,
    },
  });
  win.setIgnoreMouseEvents(true, { forward: true });
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  void win.webContents.setVisualZoomLevelLimits?.(1, 1);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, target) => {
    if (target !== url) event.preventDefault();
  });
  win.webContents.on('will-redirect', (event) => event.preventDefault());
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
  try {
    await win.loadURL(url);
  } catch (error) {
    if (!win.isDestroyed()) win.destroy();
    throw error;
  }
  if (win.isDestroyed()) throw new Error('Body closed during load');
  return win;
}

module.exports = { createLivingBody, openBodyWindow, followPrimaryWorkArea, pushToBody, HIT_LEASE_MS };
