const clamp = (value, low, high) => Math.max(low, Math.min(value, high));
const separated = (a, b) =>
  a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
const defaultBallSize = 72;
const basePet = { width: 120, height: 130 };
// Mirrors @clowder-ai/companion living-geometry.mjs. Insets exclude the
// ordinary 8px window padding: left peek, corrected pounce top and wake end
// right are all part of one reviewed transparent-surface union.
const baseLivingArt = { left: 24, top: 10, right: 15, bottom: 0 };

function petMetrics(value) {
  const ballSize = Number.isInteger(value) && value >= 48 && value <= 192 ? value : defaultBallSize;
  const scale = ballSize / defaultBallSize;
  const scaled = (input) => Math.ceil(input * scale);
  return {
    pet: { width: Math.round(basePet.width * scale), height: Math.round(basePet.height * scale) },
    art: {
      left: scaled(baseLivingArt.left),
      top: scaled(baseLivingArt.top),
      right: scaled(baseLivingArt.right),
      bottom: scaled(baseLivingArt.bottom),
    },
  };
}

/** Native screen coordinates, including negative-origin monitors. The cat is the
 * stable anchor; only the transient panel moves to fit the available work area. */
function placePetPanel({ area, pet: anchor, panel: requested, pointer, ballSize = defaultBallSize }) {
  const padding = 8;
  const metrics = petMetrics(ballSize);
  const { pet: petSize, art: livingArt } = metrics;
  const pet = {
    x: clamp(
      anchor.x,
      area.x + padding + livingArt.left,
      area.x + area.width - petSize.width - padding - livingArt.right,
    ),
    y: clamp(
      anchor.y,
      area.y + padding + livingArt.top,
      area.y + area.height - petSize.height - padding - livingArt.bottom,
    ),
    ...petSize,
  };
  const occupiedPet = {
    x: pet.x - livingArt.left,
    y: pet.y - livingArt.top,
    width: pet.width + livingArt.left + livingArt.right,
    height: pet.height + livingArt.top + livingArt.bottom,
  };
  let panel = null;
  if (requested) {
    const width = Math.min(requested.width, area.width - 2 * padding);
    let height = Math.min(requested.height, area.height - 2 * padding);
    const fit = (x, y) => ({
      x: clamp(x, area.x + padding, area.x + area.width - width - padding),
      y: clamp(y, area.y + padding, area.y + area.height - height - padding),
      width,
      height,
    });
    const above = fit(occupiedPet.x + (occupiedPet.width - width) / 2, occupiedPet.y - height - 12);
    const below = fit(occupiedPet.x + (occupiedPet.width - width) / 2, occupiedPet.y + occupiedPet.height + 12);
    const y = pointer ? pointer.y : pet.y;
    const left = fit(occupiedPet.x - width - 12, y - height / 2);
    const right = fit(occupiedPet.x + occupiedPet.width + 12, y - height / 2);
    const inward = pet.x + pet.width / 2 < area.x + area.width / 2 ? [right, left] : [left, right];
    const candidates = requested.kind === 'menu' ? [...inward, above, below] : [above, below, ...inward];
    panel = candidates.find((candidate) => separated(candidate, occupiedPet));
    if (!panel) {
      const aboveSpace = occupiedPet.y - area.y - padding - 12;
      const belowSpace = area.y + area.height - padding - occupiedPet.y - occupiedPet.height - 12;
      height = Math.max(1, Math.min(height, Math.max(aboveSpace, belowSpace)));
      panel = fit(
        occupiedPet.x + (occupiedPet.width - width) / 2,
        aboveSpace >= belowSpace ? occupiedPet.y - height - 12 : occupiedPet.y + occupiedPet.height + 12,
      );
    }
  }
  const x = Math.min(pet.x - livingArt.left, panel?.x ?? pet.x) - padding;
  const y = Math.min(pet.y - livingArt.top, panel?.y ?? pet.y) - padding;
  const right =
    Math.max(pet.x + pet.width + livingArt.right, panel ? panel.x + panel.width : pet.x + pet.width) + padding;
  const bottom =
    Math.max(pet.y + pet.height + livingArt.bottom, panel ? panel.y + panel.height : pet.y + pet.height) + padding;
  return {
    pet,
    panel,
    bounds: { x: Math.round(x), y: Math.round(y), width: Math.ceil(right - x), height: Math.ceil(bottom - y) },
  };
}
module.exports = { petMetrics, placePetPanel };
