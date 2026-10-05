const { petMetrics, placePetPanel } = require('./pet-placement.cjs');
const { createPetTravel } = require('./pet-travel.cjs');
const inside = (p, r) => r && p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
const clamp = (value, low, high) => Math.max(low, Math.min(value, high));

/** Own-window presentation only. Renderer never chooses a display, absolute
 * desktop coordinate, another window, or an unbounded drag lifetime. */
function createPetWindow({ win, screen, publish, motionLease, travelOptions = {}, now = Date.now }) {
  let anchor;
  let layout;
  let dragging;
  let ignored = false;
  let timer;
  let panelKind = 'none',
    menuPointer;
  let ballSize = 72,
    panelRequest;
  const areaFor = () => screen.getDisplayMatching(win.getBounds()).workArea;
  function shiftLayout(next, dx, dy) {
    if (!layout) return;
    layout = {
      bounds: next,
      pet: { ...layout.pet, x: layout.pet.x + dx, y: layout.pet.y + dy },
      panel: layout.panel && { ...layout.panel, x: layout.panel.x + dx, y: layout.panel.y + dy },
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
    const bounds = win.getBounds();
    const size = petMetrics(ballSize).pet;
    anchor ??= { x: bounds.x + (bounds.width - size.width) / 2, y: bounds.y + bounds.height - size.height - 8 };
    layout = placePetPanel({ area: areaFor(), pet: anchor, panel, pointer, ballSize });
    anchor = { x: layout.pet.x, y: layout.pet.y };
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
    if (panelKind === 'none') travel?.resume();
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
    const cursor = screen.getCursorScreenPoint();
    updateDrag(cursor);
    const ignore =
      !dragging && !inside(cursor, layout.pet) && (panelKind === 'bubble' || !inside(cursor, layout.panel));
    if (ignore !== ignored) {
      ignored = ignore;
      win.setIgnoreMouseEvents(ignore, { forward: true });
    }
  }
  function endDrag() {
    const ended = dragging;
    dragging = undefined;
    if (panelKind === 'none') travel?.resume();
    if (ended?.moved && panelKind === 'bubble') {
      // The ambient bubble stays open after dismiss. Let its next layout
      // place the cat at the intended edge and move the bubble inward.
      anchor = ended.target;
      publish({ kind: 'view-dismiss' });
    }
    return { kind: 'ok' };
  }
  return {
    request(command, activated) {
      if (command.kind === 'view.layout') {
        if (
          !['none', 'bubble', 'actions', 'menu', 'chat', 'decisions', 'transcript', 'settings'].includes(
            command.panel,
          ) ||
          !Number.isInteger(command.width) ||
          command.width < 120 ||
          command.width > 420 ||
          !Number.isInteger(command.height) ||
          command.height < 32 ||
          command.height > 500
        )
          return { kind: 'error', code: 'invalid_request' };
        timer ??= setInterval(tick, 32);
        timer.unref?.();
        if (command.panel !== panelKind)
          menuPointer = command.panel === 'menu' ? screen.getCursorScreenPoint() : undefined;
        panelKind = command.panel;
        panelRequest =
          command.panel === 'none' ? undefined : { kind: command.panel, width: command.width, height: command.height };
        const reply = apply(panelRequest, menuPointer);
        if (command.panel === 'none') travel?.resume();
        else travel?.pause();
        return reply;
      }
      if (command.kind === 'view.drag') {
        if (command.phase === 'end') return endDrag();
        if (command.phase !== 'start') return { kind: 'error', code: 'invalid_request' };
        if (!activated || !layout || !inside(screen.getCursorScreenPoint(), layout.pet))
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
      if (command.kind === 'view.reset') {
        if (!activated) return { kind: 'error', code: 'permission_required' };
        dragging = undefined;
        resetPosition();
        return { kind: 'ok' };
      }
      if (command.kind === 'view.hide') {
        if (!activated) return { kind: 'error', code: 'permission_required' };
        dragging = undefined;
        travel?.pause();
        win.hide();
        return { kind: 'ok' };
      }
      return null;
    },
    dismiss() {
      dragging = undefined;
      travel?.pause();
      publish({ kind: 'view-dismiss' });
    },
    setBallSize(value) {
      if (!Number.isInteger(value) || value < 48 || value > 192) return false;
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
        if (panelKind === 'none') travel?.resume();
      }
      return true;
    },
    close() {
      clearInterval(timer);
      dragging = undefined;
      travel?.close();
    },
    tick,
  };
}
module.exports = { createPetWindow };
