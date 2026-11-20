const placement = require('./pet-placement.cjs');
const { petMetrics, placePetPanel, placePanelForBody, validBallSize } = placement;
const { createPetTravel } = require('./pet-travel.cjs');
const { createLivingBody } = require('./body-window.cjs');
const { validLayoutCommand, copyPanelRequest } = require('./pet-layout-command.cjs');
const inside = (p, r) => r && p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
const clamp = (value, low, high) => Math.max(low, Math.min(value, high));
/** Own-window presentation only. Renderer never chooses a display, absolute desktop coordinate,
 * another window, or an unbounded drag lifetime. F336 living mode: this window holds only the
 * panel, next to the body's rect; travel never starts; the same tick gates the body's clicks.
 * Living mode starts when the panel is handed over: the attached body has been drawn and the panel
 * has just been told the living skin (living-mode.cjs). Until then this window is the ball, placed,
 * clickable and travelling as before, so the ball hides where it is instead of being carried onto
 * the cat (#7292 R1 P1-3; the panel learns the skin on its next state read). */
function createPetWindow({ win, screen, publish, motionLease, badge, travelOptions = {}, now = Date.now }) {
  // Native placement and hit testing use DIP coordinates. Page/pinch zoom must
  // not silently shrink the CSS viewport; the persisted ballSize owns sizing.
  void win.webContents?.setVisualZoomLevelLimits?.(1, 1);
  const normalizePageScale = () => {
    const zoom = win.webContents?.getZoomFactor?.();
    if (zoom !== undefined && zoom !== 1) win.webContents.setZoomFactor(1);
  };
  let anchor;
  let layout;
  let dragging;
  let ignored = false;
  let timer;
  let panelKind = 'none',
    menuPointer;
  let ballSize = 72,
    panelRequest,
    living,
    handedOver = false;
  const onScreen = () => living !== undefined && handedOver;
  const areaFor = () => (onScreen() ? living.area() : screen.getDisplayMatching(win.getBounds()).workArea);
  const resumeTravel = () => {
    if (!onScreen() && panelKind === 'none') travel?.resume();
  };
  const startTicking = () => {
    timer ??= setInterval(tick, 32);
    timer.unref?.();
  };
  const placeForBody = (panel, pointer) =>
    placePanelForBody(
      living.anchor() ?? placement.restingBodyRect(areaFor(), ballSize),
      panel,
      areaFor(),
      pointer,
      placement.petMetrics(ballSize).pet, // the page's anchor box: its badges stay whole with no panel open
    );
  function shiftLayout(next, dx, dy) {
    if (!layout) return;
    layout = {
      bounds: next,
      pet: { ...layout.pet, x: layout.pet.x + dx, y: layout.pet.y + dy },
      panel: layout.panel && { ...layout.panel, x: layout.panel.x + dx, y: layout.panel.y + dy },
      bubble: layout.bubble && { ...layout.bubble, x: layout.bubble.x + dx, y: layout.bubble.y + dy },
    };
    anchor = { x: layout.pet.x, y: layout.pet.y };
  }
  const travel =
    typeof motionLease === 'function'
      ? createPetTravel({
          ...travelOptions,
          acquireLease: motionLease,
          readBounds: () => win.getBounds(),
          readWorkArea: areaFor,
          onMove: (result) => shiftLayout(win.getBounds(), result.dx, result.dy),
        })
      : null;
  function apply(panel, pointer) {
    normalizePageScale();
    if (onScreen()) layout = placeForBody(panel, pointer);
    else {
      const bounds = win.getBounds();
      const size = petMetrics(ballSize).pet;
      anchor ??= { x: bounds.x + (bounds.width - size.width) / 2, y: bounds.y + bounds.height - size.height - 8 };
      layout = placePetPanel({ area: areaFor(), pet: anchor, panel, pointer, ballSize });
      anchor = { x: layout.pet.x, y: layout.pet.y };
    }
    win.setBounds(layout.bounds);
    return {
      kind: 'layout',
      pet: { x: layout.pet.x - layout.bounds.x, y: layout.pet.y - layout.bounds.y },
      panel: {
        x: (layout.panel?.x ?? layout.bounds.x) - layout.bounds.x,
        y: (layout.panel?.y ?? layout.bounds.y) - layout.bounds.y,
        width: layout.panel?.width ?? 0,
        height: layout.panel?.height ?? 0,
      },
      ...(layout.bubble
        ? {
            bubble: {
              x: layout.bubble.x - layout.bounds.x,
              y: layout.bubble.y - layout.bounds.y,
              width: layout.bubble.width,
              height: layout.bubble.height,
            },
          }
        : {}),
      width: layout.bounds.width,
      height: layout.bounds.height,
    };
  }
  function resetPosition() {
    if (!layout) apply(panelRequest, menuPointer);
    const area = areaFor();
    const metrics = petMetrics(ballSize);
    const petOffset = { x: layout.pet.x - layout.bounds.x, y: layout.pet.y - layout.bounds.y };
    const targetPet = {
      x: area.x + area.width - metrics.pet.width - metrics.art.right - 24,
      y: area.y + area.height - metrics.pet.height - metrics.art.bottom - 24,
    };
    const next = {
      ...layout.bounds,
      x: clamp(targetPet.x - petOffset.x, area.x, area.x + area.width - layout.bounds.width),
      y: clamp(targetPet.y - petOffset.y, area.y, area.y + area.height - layout.bounds.height),
    };
    const dx = next.x - layout.bounds.x;
    const dy = next.y - layout.bounds.y;
    travel?.pause();
    shiftLayout(next, dx, dy);
    win.setBounds(next);
    resumeTravel();
  }
  // A moved body moves the anchor box with him; an open panel stays where it opened (U9: his drawn rect
  // jitters with his tail). On candidate.3 he may still wander off meanwhile; holding him is next candidate.
  function followBody() {
    if (!layout || win.isDestroyed() || panelKind !== 'none' || !onScreen()) return;
    const next = placeForBody(panelRequest, menuPointer);
    layout = next;
    win.setBounds(next.bounds);
  }
  function moveWindowWithLayout(cursor, dx, dy) {
    const area = screen.getDisplayNearestPoint(cursor).workArea;
    // A view.layout reply has already placed the renderer's cat and panel
    // inside this exact native window. Move them together; re-placing only
    // the cat would shrink the Host surface behind a still-visible panel.
    const workArea = layout.bounds.width <= area.width && layout.bounds.height <= area.height ? area : areaFor();
    const next = {
      x: clamp(
        dragging.anchor.x + dx - (layout.pet.x - layout.bounds.x),
        workArea.x,
        workArea.x + workArea.width - layout.bounds.width,
      ),
      y: clamp(
        dragging.anchor.y + dy - (layout.pet.y - layout.bounds.y),
        workArea.y,
        workArea.y + workArea.height - layout.bounds.height,
      ),
      width: layout.bounds.width,
      height: layout.bounds.height,
    };
    const moveX = next.x - layout.bounds.x,
      moveY = next.y - layout.bounds.y;
    shiftLayout(next, moveX, moveY);
    dragging.target = { x: dragging.anchor.x + dx, y: dragging.anchor.y + dy };
    win.setBounds(next);
  }
  function updateDrag(cursor) {
    if (!dragging) return;
    if (now() - dragging.at > 15000) {
      dragging = undefined;
      return;
    }
    const dx = cursor.x - dragging.cursor.x,
      dy = cursor.y - dragging.cursor.y;
    if (Math.hypot(dx, dy) < 6 && !dragging.moved) return;
    if (!dragging.moved) {
      dragging.moved = true;
      publish({ kind: 'view-dismiss' });
    }
    moveWindowWithLayout(cursor, dx, dy);
  }
  function tick() {
    if (win.isDestroyed() || !layout) return;
    normalizePageScale();
    const cursor = screen.getCursorScreenPoint();
    updateDrag(cursor);
    const overPanel = panelKind !== 'bubble' && Boolean(inside(cursor, layout.panel));
    // In living mode the panel window holds no pet: only the open panel and the badges the panel draws
    // (pending decisions; stop sharing while a screen is shared or picked) take clicks there, over the body.
    const overBadge = onScreen() && overPanelBadge(cursor);
    living?.tick(cursor, overPanel || overBadge); // the body's own lease runs from attach
    const ignore = !dragging && !overPanel && !overBadge && (onScreen() || !inside(cursor, layout.pet));
    if (ignore !== ignored) {
      ignored = ignore;
      win.setIgnoreMouseEvents(ignore, { forward: true });
    }
  }
  function overPanelBadge(cursor) {
    const area = areaFor();
    const rects = [badge?.rect(layout, ballSize, area), badge?.shareRect?.(layout, ballSize, area)];
    return rects.some((rect) => Boolean(inside(cursor, rect)));
  }
  function endDrag() {
    const ended = dragging;
    dragging = undefined;
    resumeTravel();
    if (ended?.moved && panelKind === 'bubble') {
      // The ambient bubble stays open after dismiss. Let its next layout
      // place the cat at the intended edge and move the bubble inward.
      anchor = ended.target;
      publish({ kind: 'view-dismiss' });
    }
    return { kind: 'ok' };
  }
  function requestLayout(command) {
    if (!validLayoutCommand(command)) return { kind: 'error', code: 'invalid_request' };
    startTicking();
    if (command.panel !== panelKind) menuPointer = command.panel === 'menu' ? screen.getCursorScreenPoint() : undefined;
    panelKind = command.panel;
    panelRequest = copyPanelRequest(command);
    const reply = apply(panelRequest, menuPointer);
    if (command.panel === 'none') resumeTravel();
    else travel?.pause();
    return reply;
  }
  function requestDrag(command, activated) {
    if (command.phase === 'end') return endDrag();
    if (command.phase !== 'start') return { kind: 'error', code: 'invalid_request' };
    if (onScreen() || !activated || !layout || !inside(screen.getCursorScreenPoint(), layout.pet))
      return { kind: 'error', code: 'permission_required' };
    travel?.pause();
    dragging = {
      anchor: { x: layout.pet.x, y: layout.pet.y },
      cursor: screen.getCursorScreenPoint(),
      at: now(),
      moved: false,
    };
    return { kind: 'ok' };
  }
  function requestReset(activated) {
    if (!activated) return { kind: 'error', code: 'permission_required' };
    dragging = undefined;
    if (!onScreen()) resetPosition(); // a living cat owns his own spot inside the body window
    return { kind: 'ok' };
  }
  function requestHide(activated) {
    if (!activated) return { kind: 'error', code: 'permission_required' };
    dragging = undefined;
    travel?.pause();
    win.hide();
    return { kind: 'ok' };
  }
  function request(command, activated) {
    if (command.kind === 'view.layout') return requestLayout(command);
    if (command.kind === 'view.drag') return requestDrag(command, activated);
    if (command.kind === 'view.reset') return requestReset(activated);
    if (command.kind === 'view.hide') return requestHide(activated);
    return null;
  }
  return {
    request,
    dismiss() {
      dragging = undefined;
      travel?.pause();
      publish({ kind: 'view-dismiss' });
    },
    setBallSize(value) {
      if (!validBallSize(value)) return false;
      if (value === ballSize) return true;
      const before = petMetrics(ballSize).pet;
      const after = petMetrics(value).pet;
      if (anchor)
        anchor = {
          x: anchor.x + (before.width - after.width) / 2,
          y: anchor.y + before.height - after.height,
        };
      ballSize = value;
      if (layout) {
        travel?.pause();
        apply(panelRequest, menuPointer);
        resumeTravel();
      }
      return true;
    },
    /** Internal swap in (F336): the Host-registered body window of this generation. */
    attachBody(bodyWin, generation) {
      const was = onScreen();
      living?.release();
      living = createLivingBody({ win: bodyWin, generation, screen, now });
      handedOver = false;
      startTicking();
      if (was) {
        apply(panelRequest, menuPointer); // a replaced body: the ball until the new one is handed over
        resumeTravel();
      }
    },
    /** The attached body has been drawn at least once. */
    bodyDrawn: () => living?.shown() === true,
    /** The panel was just told the living skin: from now on this window is the living cat's panel. */
    handOver() {
      if (handedOver || !living?.shown()) return;
      handedOver = true;
      dragging = undefined;
      travel?.pause();
      living.reveal();
      apply(panelRequest, menuPointer);
    },
    /** A swap out begins: he leaves the screen now and this window is the ball again at once. */
    concealBody() {
      if (!living || !handedOver) return; // never revealed: already transparent and click-through
      living.conceal();
      handedOver = false;
      apply(panelRequest, menuPointer);
      resumeTravel();
    },
    /** Internal swap out: back to the ball inside the panel window. */
    detachBody() {
      if (!living) return;
      living.release();
      living = undefined;
      handedOver = false;
      apply(panelRequest, menuPointer);
      resumeTravel();
    },
    /** body.* commands from the body route; only the current generation is heard. */
    requestBody(sender, command) {
      if (!living || sender?.role !== 'body' || sender.generation !== living.generation)
        return { kind: 'error', code: 'permission_required' };
      // A context click opens the ordinary menu beside his anchor, a second one closes it (as on the ball);
      // the menu's window takes focus, so Escape and a click elsewhere (blur dismisses) close it (U9).
      if (command.kind === 'body.menu') {
        if (Object.keys(command).join() !== 'kind') return { kind: 'error', code: 'invalid_request' };
        if (panelKind === 'menu') {
          publish({ kind: 'view-dismiss' });
          return { kind: 'ok' };
        }
        publish({ kind: 'view-open', panel: 'menu' });
        win.focus();
        return { kind: 'ok' };
      }
      const reply = living.request(command);
      if (command.kind === 'body.anchor' && reply.kind === 'ok') followBody();
      return reply;
    },
    close() {
      clearInterval(timer);
      dragging = undefined;
      living?.release();
      travel?.close();
    },
    tick,
  };
}
module.exports = { createPetWindow };
