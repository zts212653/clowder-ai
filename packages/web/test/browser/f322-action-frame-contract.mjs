import assert from 'node:assert/strict';

function assertDerivedSurfaces(surfaces, name) {
  for (const surface of surfaces) {
    if (surface.state === 'available') continue;
    assert(
      surface.visibility === 'hidden' && surface.inert && surface.ariaHidden === 'true' && !surface.activeDescendant,
      `${name}: a derived action surface escapes unavailable ownership ${JSON.stringify(surface)}`,
    );
  }
}

export function assertActionFrame(frame, name) {
  assert(
    frame.rowScroll <= frame.rowClient + 1,
    `${name}: a frame changes row scroll geometry ${JSON.stringify(frame)}`,
  );
  assert(frame.portScroll <= frame.portClient + 1, `${name}: a frame changes port scroll geometry`);
  assert(frame.slotWidth === 0 && frame.slotHeight === 0, `${name}: the author slot reserves layout space`);
  assertDerivedSurfaces(frame.surfaces ?? [], name);
  const closed = frame.visibility === 'hidden' && frame.inert && frame.ariaHidden === 'true' && !frame.activeDescendant;
  const pending =
    frame.ready === 'false' &&
    /^\d+$/.test(frame.latestEpoch ?? '') &&
    frame.committedEpoch !== frame.latestEpoch &&
    closed;
  if (frame.visibility !== 'hidden') {
    assert(
      frame.ready === 'true' && /^\d+$/.test(frame.latestEpoch ?? '') && frame.committedEpoch === frame.latestEpoch,
      `${name}: an uncommitted epoch exposes a control`,
    );
  }
  for (const control of frame.controls) {
    const left = Math.max(0, control.columnLeft, control.portLeft);
    const right = Math.min(frame.viewport, control.columnRight, control.portRight);
    const horizontal = control.left >= left - 1 && control.right <= right + 1;
    const vertical = control.top >= control.portTop - 1 && control.bottom <= control.portBottom + 1;
    if (pending) continue; // Explicit five-part fail-closed state; every raw control remains in the artifact.
    assert(horizontal, `${name}: a settled control escapes horizontal bounds ${JSON.stringify(frame)}`);
    assert(
      vertical || (frame.ready === 'true' && closed),
      `${name}: a control escapes the scrollport ${JSON.stringify(frame)}`,
    );
  }
}
