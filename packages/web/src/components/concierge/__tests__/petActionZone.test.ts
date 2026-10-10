import { describe, expect, it } from 'vitest';
import { PET_TOOLBAR_CLEARANCE_PX, resolvePetPosition, resolveWalkedPetPosition } from '../petActionZone';

const ballSize = 72;

function expectClearOfFooter(
  position: { x: number; y: number },
  zone: { left: number; top: number; right: number; bottom: number },
) {
  const overlapsX = position.x < zone.right && position.x + ballSize > zone.left;
  const overlapsY = position.y < zone.bottom && position.y + ballSize + PET_TOOLBAR_CLEARANCE_PX > zone.top;
  expect(overlapsX && overlapsY).toBe(false);
}

describe('pet action-zone placement', () => {
  it.each([
    { width: 1643, height: 997, footerTop: 813, footerLeft: 292 },
    { width: 1100, height: 800, footerTop: 570, footerLeft: 200 },
  ])('parks the bottom-right ball above live chat controls at $width×$height', ({
    width,
    height,
    footerTop,
    footerLeft,
  }) => {
    const zone = { left: footerLeft, top: footerTop, right: width, bottom: height };
    const position = resolvePetPosition(
      { x: width - ballSize - 24, y: height - ballSize - PET_TOOLBAR_CLEARANCE_PX - 24 },
      ballSize,
      { width, height },
      [zone],
    );
    expect(position.x).toBe(width - ballSize - 24);
    expect(position.y).toBe(footerTop - ballSize - PET_TOOLBAR_CLEARANCE_PX - 8);
    expectClearOfFooter(position, zone);
  });

  it('projects a persisted drag into the footer back to a clickable resting position', () => {
    const zone = { left: 292, top: 813, right: 1643, bottom: 997 };
    const position = resolvePetPosition({ x: 1547, y: 865 }, ballSize, { width: 1643, height: 997 }, [zone]);
    expect(position).toEqual({ x: 1547, y: 689 });
    expectClearOfFooter(position, zone);
  });

  it('does not let an autonomous step walk back over the footer', () => {
    const zone = { left: 292, top: 813, right: 1643, bottom: 997 };
    const position = resolvePetPosition({ x: 1510, y: 710 }, ballSize, { width: 1643, height: 997 }, [zone]);
    expect(position).toEqual({ x: 1510, y: 689 });
    expectClearOfFooter(position, zone);
  });

  it('leaves autonomous steps outside the action zone free to move', () => {
    const position = resolvePetPosition({ x: 1100, y: 440 }, ballSize, { width: 1643, height: 997 }, [
      { left: 292, top: 813, right: 1643, bottom: 997 },
    ]);
    expect(position).toEqual({ x: 1100, y: 440 });
  });

  it('moves farther up when the queue or composer grows, and releases the space when it closes', () => {
    const viewport = { width: 1643, height: 997 };
    const wanted = { x: 1547, y: 857 };
    expect(resolvePetPosition(wanted, ballSize, viewport, [{ left: 292, top: 813, right: 1643, bottom: 997 }]).y).toBe(
      689,
    );
    expect(resolvePetPosition(wanted, ballSize, viewport, [{ left: 292, top: 700, right: 1643, bottom: 997 }]).y).toBe(
      576,
    );
    expect(resolvePetPosition(wanted, ballSize, viewport, [])).toEqual(wanted);
  });

  it('does not move a ball that is horizontally clear of the action zone', () => {
    const position = resolvePetPosition({ x: 60, y: 850 }, ballSize, { width: 1643, height: 997 }, [
      { left: 292, top: 813, right: 1643, bottom: 997 },
    ]);
    expect(position.y).toBe(850);
  });

  it('keeps the desired height during a sideways walk above a temporary queue', () => {
    const viewport = { width: 1643, height: 997 };
    const zone = { left: 292, top: 813, right: 1643, bottom: 997 };
    const raw = { x: 1547, y: 857 };
    const rendered = resolvePetPosition(raw, ballSize, viewport, [zone]);
    const walked = resolveWalkedPetPosition(raw, rendered, { x: -40, y: 0 }, ballSize, viewport, [zone]);
    if (!walked) throw new Error('expected a sideways walk');
    expect(walked).toEqual({ x: 1507, y: 857 });
    expect(resolvePetPosition(walked, ballSize, viewport, [zone])).toEqual({ x: 1507, y: 689 });
    expect(resolvePetPosition(walked, ballSize, viewport, [])).toEqual({ x: 1507, y: 857 });
  });

  it('rejects a blocked walk without accumulating invisible movement', () => {
    const viewport = { width: 1643, height: 997 };
    const zone = { left: 292, top: 813, right: 1643, bottom: 997 };
    const raw = { x: 1547, y: 857 };
    const rendered = resolvePetPosition(raw, ballSize, viewport, [zone]);
    expect(resolveWalkedPetPosition(raw, rendered, { x: 0, y: 40 }, ballSize, viewport, [zone])).toBeNull();
    expect(resolveWalkedPetPosition(raw, rendered, { x: 0, y: -40 }, ballSize, viewport, [zone])).toBeNull();
    expect(resolveWalkedPetPosition(raw, rendered, { x: 0, y: -200 }, ballSize, viewport, [zone])).toEqual({
      x: 1547,
      y: 657,
    });
  });

  it('does not save the lift when a horizontal step enters the footer', () => {
    const viewport = { width: 1643, height: 997 };
    const zone = { left: 292, top: 813, right: 1643, bottom: 997 };
    const raw = { x: 180, y: 850 };
    const rendered = resolvePetPosition(raw, ballSize, viewport, [zone]);
    const walked = resolveWalkedPetPosition(raw, rendered, { x: 50, y: 0 }, ballSize, viewport, [zone]);
    if (!walked) throw new Error('expected a sideways walk');
    expect(walked).toEqual({ x: 230, y: 850 });
    expect(resolvePetPosition(walked, ballSize, viewport, [zone])).toEqual({ x: 230, y: 689 });
    expect(resolvePetPosition(walked, ballSize, viewport, [])).toEqual(walked);
  });

  it('preserves the desired height during a diagonal step while projected above the footer', () => {
    const viewport = { width: 1643, height: 997 };
    const zone = { left: 292, top: 813, right: 1643, bottom: 997 };
    const raw = { x: 1547, y: 857 };
    const rendered = resolvePetPosition(raw, ballSize, viewport, [zone]);
    const walked = resolveWalkedPetPosition(raw, rendered, { x: -30, y: -20 }, ballSize, viewport, [zone]);
    if (!walked) throw new Error('expected a diagonal walk');
    expect(walked).toEqual({ x: 1517, y: 837 });
    expect(resolvePetPosition(walked, ballSize, viewport, [zone])).toEqual({ x: 1517, y: 689 });
  });
});
