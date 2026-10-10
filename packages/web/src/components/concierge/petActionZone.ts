/** The chat footer contains queue actions and the composer. The pet may be dragged
 * through it, but must not settle or walk over it. Geometry is viewport-relative. */
export interface PetActionZone {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface PetPosition {
  x: number;
  y: number;
}

export const PET_TOOLBAR_CLEARANCE_PX = 44;
const ACTION_GAP_PX = 8;

export function resolvePetPosition(
  position: PetPosition,
  ballSize: number,
  viewport: { width: number; height: number },
  actionZones: readonly PetActionZone[],
): PetPosition {
  const footprintHeight = ballSize + PET_TOOLBAR_CLEARANCE_PX;
  const x = Math.max(0, Math.min(position.x, viewport.width - ballSize));
  let y = Math.max(0, Math.min(position.y, viewport.height - footprintHeight));

  // The protected surfaces are bottom-anchored chat footers. Preserve the
  // user's horizontal drag position and park the ball immediately above them.
  for (const zone of actionZones) {
    const overlapsX = x < zone.right + ACTION_GAP_PX && x + ballSize > zone.left - ACTION_GAP_PX;
    const overlapsY = y < zone.bottom + ACTION_GAP_PX && y + footprintHeight > zone.top - ACTION_GAP_PX;
    if (overlapsX && overlapsY) {
      y = Math.max(0, zone.top - footprintHeight - ACTION_GAP_PX);
    }
  }

  return { x, y };
}

/** Apply a visible autonomous step without saving a footer's temporary lift.
 * A blocked step does not accumulate movement behind the projection. */
export function resolveWalkedPetPosition(
  desired: PetPosition,
  rendered: PetPosition,
  delta: PetPosition,
  ballSize: number,
  viewport: { width: number; height: number },
  actionZones: readonly PetActionZone[],
): PetPosition | null {
  const nextDesired = { x: desired.x + delta.x, y: desired.y + delta.y };
  const nextRendered = resolvePetPosition(nextDesired, ballSize, viewport, actionZones);
  if (nextRendered.x === rendered.x && nextRendered.y === rendered.y) return null;
  return nextDesired;
}
