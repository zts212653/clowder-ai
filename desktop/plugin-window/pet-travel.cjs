const clamp = (value, low, high) => Math.max(low, Math.min(value, high));

function validRect(value) {
  return (
    value &&
    [value.x, value.y, value.width, value.height].every(Number.isSafeInteger) &&
    value.width > 0 &&
    value.height > 0
  );
}

/** Choose a short horizontal walk on the current display. The Host lease remains
 * the authority that clamps and applies every native coordinate. */
function chooseTravelTarget({ area, bounds, random = Math.random }) {
  if (!validRect(area) || !validRect(bounds)) return null;
  const margin = 16;
  const minX = area.x + margin;
  const maxX = area.x + area.width - bounds.width - margin;
  const minY = area.y + margin;
  const maxY = area.y + area.height - bounds.height - margin;
  if (maxX < minX || maxY < minY) return null;
  const areaMiddle = area.x + area.width / 2;
  const windowMiddle = bounds.x + bounds.width / 2;
  let direction = windowMiddle < areaMiddle ? 1 : -1;
  let available = direction > 0 ? maxX - bounds.x : bounds.x - minX;
  if (available < 48) {
    direction *= -1;
    available = direction > 0 ? maxX - bounds.x : bounds.x - minX;
  }
  if (available < 48) return null;
  const rawSample = random();
  const sample = Number.isFinite(rawSample) ? clamp(rawSample, 0, 1) : 0;
  const distance = Math.min(available, 120 + Math.round(sample * 100));
  return {
    x: Math.round(clamp(bounds.x + direction * distance, minX, maxX)),
    y: Math.round(clamp(bounds.y, minY, maxY)),
  };
}

function createPetTravel({
  acquireLease,
  readBounds,
  readWorkArea,
  onMove = () => {},
  now = Date.now,
  setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout,
  random = Math.random,
  idleDelayMs = 60_000,
  cooldownMs = 120_000,
  cooldownJitterMs = 60_000,
  frameMs = 80,
  stepPx = 12,
  maxDurationMs = 12_000,
}) {
  let timer;
  let active;
  let paused = true;
  let closed = false;

  const clearScheduled = () => {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
  };
  const detach = () => {
    if (active?.onAbort) active.lease.signal.removeEventListener('abort', active.onAbort);
    active = undefined;
  };
  const schedule = (delay) => {
    if (closed || paused || active || timer !== undefined) return;
    timer = setTimer(
      () => {
        timer = undefined;
        begin();
      },
      Math.max(0, delay),
    );
    timer?.unref?.();
  };
  const finish = (delay = idleDelayMs) => {
    clearScheduled();
    detach();
    schedule(delay);
  };
  const step = () => {
    timer = undefined;
    if (!active || paused || closed || active.lease.signal.aborted) return finish();
    if (now() - active.startedAt >= maxDurationMs) return finish();
    const bounds = readBounds();
    if (!validRect(bounds)) return finish();
    const dx = active.target.x - bounds.x;
    const dy = active.target.y - bounds.y;
    const distance = Math.hypot(dx, dy);
    if (distance < 1) {
      const jitter = Math.max(0, cooldownJitterMs) * clamp(random(), 0, 1);
      return finish(Math.max(0, cooldownMs) + Math.round(jitter));
    }
    const scale = Math.min(1, Math.max(1, stepPx) / distance);
    const target = {
      x: scale === 1 ? active.target.x : Math.round(bounds.x + dx * scale),
      y: scale === 1 ? active.target.y : Math.round(bounds.y + dy * scale),
    };
    let result;
    try {
      result = active.lease.moveTo(target);
    } catch {
      return finish();
    }
    if (result?.status !== 'moved') return finish();
    onMove(result);
    if (result.dx === 0 && result.dy === 0) return finish();
    timer = setTimer(step, Math.max(1, frameMs));
    timer?.unref?.();
  };
  function begin() {
    if (closed || paused || active) return;
    const lease = acquireLease?.();
    const bounds = readBounds?.();
    const area = readWorkArea?.();
    if (!lease || !lease.signal || typeof lease.moveTo !== 'function' || lease.signal.aborted)
      return schedule(idleDelayMs);
    const target = chooseTravelTarget({ area, bounds, random });
    if (!target) return schedule(cooldownMs);
    const current = {
      lease,
      target,
      startedAt: now(),
      onAbort: () => finish(),
    };
    active = current;
    lease.signal.addEventListener('abort', current.onAbort, { once: true });
    step();
  }

  return {
    resume() {
      if (closed || !paused) return;
      paused = false;
      schedule(idleDelayMs);
    },
    pause() {
      if (closed) return;
      paused = true;
      clearScheduled();
      detach();
    },
    close() {
      if (closed) return;
      closed = true;
      clearScheduled();
      detach();
    },
  };
}

module.exports = { chooseTravelTarget, createPetTravel };
