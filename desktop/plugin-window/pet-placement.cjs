const clamp = (value, low, high) => Math.max(low, Math.min(value, high));
const separated = (a, b) =>
  a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
const defaultBallSize = 72;
const minimumBallSize = 43;
const maximumBallSize = 192;
const basePet = { width: 120, height: 130 };
// Mirrors @clowder-ai/companion living-geometry.mjs. Insets exclude the
// ordinary 8px window padding: left peek, corrected pounce top and wake end
// right are all part of one reviewed transparent-surface union.
const baseLivingArt = { left: 24, top: 10, right: 15, bottom: 0 };

const validBallSize = (value) => Number.isInteger(value) && value >= minimumBallSize && value <= maximumBallSize;

function petMetrics(value) {
  const ballSize = validBallSize(value) ? value : defaultBallSize;
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

function placeRequestedPanel({ area, pet, occupiedPet, requested, pointer, padding }) {
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
  const sideY = (pointer?.y ?? pet.y) - height / 2;
  const left = fit(occupiedPet.x - width - 12, sideY);
  const right = fit(occupiedPet.x + occupiedPet.width + 12, sideY);
  const opensRight = pet.x + pet.width / 2 < area.x + area.width / 2;
  const inward = opensRight ? [right, left] : [left, right];
  const call = requested.kind === 'actions' ? requested.call : undefined;
  const controlsY = occupiedPet.y + occupiedPet.height - height;
  const controlsLeft = fit(occupiedPet.x - width - 12, controlsY);
  const controlsRight = fit(occupiedPet.x + occupiedPet.width + 12, controlsY);
  const controlsInward = opensRight ? [controlsRight, controlsLeft] : [controlsLeft, controlsRight];
  let candidates = [above, below, ...inward];
  if (call?.presentation === 'lite') candidates = [below, above, ...inward];
  else if (call?.presentation === 'controls') candidates = [...controlsInward, below, above];
  else if (requested.kind === 'menu') candidates = [...inward, above, below];
  let panel = candidates.find((candidate) => separated(candidate, occupiedPet));
  if (!panel) {
    const aboveSpace = occupiedPet.y - area.y - padding - 12;
    const belowSpace = area.y + area.height - padding - occupiedPet.y - occupiedPet.height - 12;
    height = Math.max(1, Math.min(height, Math.max(aboveSpace, belowSpace)));
    panel = fit(
      occupiedPet.x + (occupiedPet.width - width) / 2,
      aboveSpace >= belowSpace ? occupiedPet.y - height - 12 : occupiedPet.y + occupiedPet.height + 12,
    );
  }
  return { call, panel };
}

function placeCallBubble({ area, pet, occupiedPet, panel, requested, padding }) {
  if (!requested) return null;
  const size = {
    width: Math.min(requested.width, area.width - 2 * padding),
    height: Math.min(requested.height, area.height - 2 * padding),
  };
  const fit = (x, y) => ({
    x: clamp(x, area.x + padding, area.x + area.width - size.width - padding),
    y: clamp(y, area.y + padding, area.y + area.height - size.height - padding),
    ...size,
  });
  const abovePet = fit(occupiedPet.x + (occupiedPet.width - size.width) / 2, occupiedPet.y - size.height - 12);
  const abovePanel = fit(panel.x + (panel.width - size.width) / 2, panel.y - size.height - 8);
  const belowPanel = fit(panel.x + (panel.width - size.width) / 2, panel.y + panel.height + 8);
  const left = fit(occupiedPet.x - size.width - 12, occupiedPet.y + (occupiedPet.height - size.height) / 2);
  const right = fit(occupiedPet.x + occupiedPet.width + 12, occupiedPet.y + (occupiedPet.height - size.height) / 2);
  const inward = pet.x + pet.width / 2 < area.x + area.width / 2 ? [right, left] : [left, right];
  const candidates =
    panel.y + panel.height <= occupiedPet.y
      ? [abovePanel, ...inward, belowPanel, abovePet]
      : [abovePet, ...inward, abovePanel, belowPanel];
  const clear = (candidate) => separated(candidate, occupiedPet) && separated(candidate, panel);
  const placed = candidates.find(clear);
  if (placed) return placed;
  const corners = [
    [area.x + padding, area.y + padding],
    [area.x + area.width - size.width - padding, area.y + padding],
    [area.x + padding, area.y + area.height - size.height - padding],
    [area.x + area.width - size.width - padding, area.y + area.height - size.height - padding],
  ];
  return corners.map(([x, y]) => fit(x, y)).find(clear) ?? null;
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
  let bubble = null;
  if (requested) {
    const placed = placeRequestedPanel({ area, pet, occupiedPet, requested, pointer, padding });
    panel = placed.panel;
    bubble = placeCallBubble({ area, pet, occupiedPet, panel, requested: placed.call?.bubble, padding });
  }
  const x = Math.min(pet.x - livingArt.left, panel?.x ?? pet.x, bubble?.x ?? pet.x) - padding;
  const y = Math.min(pet.y - livingArt.top, panel?.y ?? pet.y, bubble?.y ?? pet.y) - padding;
  const right =
    Math.max(
      pet.x + pet.width + livingArt.right,
      panel ? panel.x + panel.width : pet.x + pet.width,
      bubble ? bubble.x + bubble.width : pet.x + pet.width,
    ) + padding;
  const bottom =
    Math.max(
      pet.y + pet.height + livingArt.bottom,
      panel ? panel.y + panel.height : pet.y + pet.height,
      bubble ? bubble.y + bubble.height : pet.y + pet.height,
    ) + padding;
  return {
    pet,
    panel,
    ...(bubble ? { bubble } : {}),
    bounds: { x: Math.round(x), y: Math.round(y), width: Math.ceil(right - x), height: Math.ceil(bottom - y) },
  };
}
module.exports = { petMetrics, placePetPanel, validBallSize };
