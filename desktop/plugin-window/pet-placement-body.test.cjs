// F336 Phase C U6: in living mode the panel sits next to the cat's real visible body rect.
// Only the panel (and the call bubble) is clamped into the work area; the cat never moves.
const assert = require('node:assert/strict');
const test = require('node:test');
const { placePanelForBody, placePetPanel } = require('./pet-placement.cjs');

const area = { x: 0, y: 25, width: 1440, height: 850 };
const panels = [
  { kind: 'menu', width: 180, height: 220 },
  { kind: 'chat', width: 340, height: 500 },
  { kind: 'decisions', width: 360, height: 420 },
  { kind: 'bubble', width: 240, height: 64 },
  { kind: 'actions', width: 220, height: 30, call: { presentation: 'lite', bubble: { width: 320, height: 62 } } },
  { kind: 'actions', width: 220, height: 120, call: { presentation: 'controls', bubble: { width: 260, height: 80 } } },
];

function within(rect, outer, label) {
  assert.ok(rect.x >= outer.x && rect.y >= outer.y, `${label}: top-left inside`);
  assert.ok(rect.x + rect.width <= outer.x + outer.width, `${label}: right edge inside`);
  assert.ok(rect.y + rect.height <= outer.y + outer.height, `${label}: bottom edge inside`);
}
const gap = (a, b) =>
  Math.hypot(
    Math.max(0, a.x - (b.x + b.width), b.x - (a.x + a.width)),
    Math.max(0, a.y - (b.y + b.height), b.y - (a.y + a.height)),
  );
function disjoint(a, b, label) {
  assert.ok(
    a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y,
    `${label}: does not cover the cat`,
  );
}

function assertNextToBody(body, workArea, label) {
  for (const panel of panels) {
    const before = { ...body };
    const result = placePanelForBody(body, panel, workArea);
    const name = `${label} ${panel.kind}${panel.call ? `/${panel.call.presentation}` : ''}`;
    assert.deepEqual(body, before, `${name}: the input rect is not mutated`);
    assert.deepEqual(result.pet, before, `${name}: the cat is neither moved nor resized`);
    within(result.panel, workArea, `${name} panel`);
    disjoint(result.panel, body, name);
    assert.ok(gap(result.panel, body) <= 13, `${name}: the panel stays adjacent to the cat`);
    if (result.bubble) {
      within(result.bubble, workArea, `${name} bubble`);
      disjoint(result.bubble, body, `${name} bubble`);
      disjoint(result.bubble, result.panel, `${name} bubble vs panel`);
    }
    within(result.panel, result.bounds, `${name}: the native panel window holds the panel`);
    if (result.bubble) within(result.bubble, result.bounds, `${name}: the native panel window holds the bubble`);
    within(result.bounds, workArea, `${name}: the native panel window stays in the work area`);
    for (const key of ['x', 'y', 'width', 'height']) assert.ok(Number.isInteger(result.bounds[key]), `${name} ${key}`);
  }
}

test('a lying cat (wide and low on the floor) gets its panels above or beside the real wide rect', () => {
  const lying = { x: 560, y: 790, width: 300, height: 70 };
  assertNextToBody(lying, area, 'lying');
  const chat = placePanelForBody(lying, { kind: 'chat', width: 340, height: 500 }, area);
  assert.ok(chat.panel.y + chat.panel.height <= lying.y, 'chat opens above the lying cat');
  const ball = placePetPanel({ area, pet: lying, panel: { kind: 'chat', width: 340, height: 500 } });
  assert.deepEqual([ball.pet.width, ball.pet.height], [120, 130], 'the ball placement would rebuild a 120x130 cat');
});

test('a jumping cat near the ceiling gets its panels below or beside, never off screen', () => {
  const jumping = { x: 640, y: 40, width: 110, height: 150 };
  assertNextToBody(jumping, area, 'jumping');
  const actions = placePanelForBody(jumping, { kind: 'actions', width: 220, height: 70 }, area);
  assert.ok(actions.panel.y >= jumping.y + jumping.height, 'no room above: actions flip below');
});

test('at the left and right edges the panel opens inward and the cat stays at the edge', () => {
  const left = { x: 0, y: 735, width: 120, height: 130 };
  const right = { x: 1440 - 120, y: 735, width: 120, height: 130 };
  assertNextToBody(left, area, 'left edge');
  assertNextToBody(right, area, 'right edge');
  const menuLeft = placePanelForBody(left, { kind: 'menu', width: 180, height: 220 }, area);
  const menuRight = placePanelForBody(right, { kind: 'menu', width: 180, height: 220 }, area);
  assert.ok(menuLeft.panel.x >= left.x + left.width, 'a left-edge menu opens to the right');
  assert.ok(menuRight.panel.x + menuRight.panel.width <= right.x, 'a right-edge menu opens to the left');
});

test('a work area change keeps the panel adjacent and inside while the cat rect is unchanged', () => {
  const body = { x: 900, y: 700, width: 160, height: 110 };
  const docked = { x: 0, y: 25, width: 1440, height: 790 }; // the Dock appeared and the floor rose
  const smaller = { x: 0, y: 25, width: 1100, height: 850 }; // a narrower primary display
  for (const workArea of [area, docked, smaller])
    assertNextToBody(body, workArea, `area ${workArea.width}x${workArea.height}`);
});

test("with no panel the window is the badge anchor box at the cat's bottom right, kept inside the work area", () => {
  // The page draws its badges (pending decisions top right, stop sharing bottom right) on a 120 x 130 anchor box
  // at the layout's pet point; the window must hold all of it or the stop-sharing badge is cut off (F317).
  const anchorSize = { width: 120, height: 130 };
  const lying = { x: 300, y: 700, width: 140, height: 110 };
  const result = placePanelForBody(lying, undefined, area, undefined, anchorSize);
  assert.equal(result.panel, null);
  const box = { x: 320, y: 680, width: 120, height: 130 };
  assert.deepEqual(result.pet, box, 'bottom right aligned with the cat');
  assert.deepEqual(result.bounds, box);
  const atCorner = { x: area.x + area.width - 100, y: area.y + area.height - 60, width: 100, height: 60 };
  const clamped = placePanelForBody(atCorner, undefined, area, undefined, anchorSize).pet;
  assert.ok(clamped.x >= area.x && clamped.x + clamped.width <= area.x + area.width, 'inside horizontally');
  assert.ok(clamped.y >= area.y && clamped.y + clamped.height <= area.y + area.height, 'inside vertically');
  assert.deepEqual(placePanelForBody(lying, undefined, area).bounds, lying, 'no anchor size: the cat rect, as before');
});
