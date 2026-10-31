const clamp = (value, low, high) => Math.max(low, Math.min(value, high));

function validTarget(target) {
  return (
    target &&
    Object.keys(target).sort().join(',') === 'x,y' &&
    Number.isSafeInteger(target.x) &&
    Number.isSafeInteger(target.y)
  );
}

function boundedPosition(win, screen, target) {
  const before = win.getBounds();
  const area = screen.getDisplayNearestPoint(target).workArea;
  if (
    ![before.x, before.y, before.width, before.height, area.x, area.y, area.width, area.height].every(
      Number.isSafeInteger,
    ) ||
    before.width <= 0 ||
    before.height <= 0 ||
    area.width < before.width ||
    area.height < before.height
  )
    return null;
  return {
    before,
    x: clamp(target.x, area.x, area.x + area.width - before.width),
    y: clamp(target.y, area.y, area.y + area.height - before.height),
  };
}

function applyNativeTarget(win, screen, target) {
  if (!validTarget(target)) return { status: 'invalid_target' };
  try {
    const position = boundedPosition(win, screen, target);
    if (!position) return { status: 'unavailable' };
    const { before, x, y } = position;
    win.setBounds({ ...before, x, y });
    return { status: 'moved', x, y, dx: x - before.x, dy: y - before.y };
  } catch {
    return { status: 'native_move_failed' };
  }
}

/** Host-owned native movement authority. Only trusted pet policy receives its lease. */
function createWindowMotion({ win, screen, systemPreferences, isAuthorized }) {
  let generation = 0;
  let active;
  let closed = false;

  function blocked() {
    if (win.isDestroyed()) return 'destroyed';
    if (!isAuthorized()) return 'lost_authority';
    try {
      if (systemPreferences.getAnimationSettings().prefersReducedMotion !== false) return 'reduced_motion';
    } catch {
      return 'reduced_motion';
    }
    return null;
  }

  function revoke(reason = 'revoked') {
    ++generation;
    active?.controller.abort(reason);
    active = undefined;
  }

  function current() {
    if (closed || !active) return null;
    const reason = blocked();
    if (reason) {
      revoke(reason);
      return null;
    }
    return active.lease;
  }

  function arm() {
    if (closed) return null;
    if (current()) return active.lease;
    if (blocked()) return null;
    const controller = new AbortController();
    const leaseGeneration = ++generation;
    const lease = Object.freeze({
      generation: leaseGeneration,
      signal: controller.signal,
      moveTo(target) {
        if (closed || active?.lease !== lease || controller.signal.aborted) return { status: 'cancelled' };
        const reason = blocked();
        if (reason) {
          revoke(reason);
          return { status: reason };
        }
        const result = applyNativeTarget(win, screen, target);
        if (result.status === 'native_move_failed') {
          revoke('native_move_failed');
          return { status: 'unavailable' };
        }
        return result;
      },
    });
    active = { controller, lease };
    return lease;
  }

  return {
    arm,
    current,
    revoke,
    close() {
      if (closed) return;
      closed = true;
      revoke('closed');
    },
  };
}

module.exports = { createWindowMotion };
