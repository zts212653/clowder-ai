const assert = require('node:assert/strict');
const test = require('node:test');
const { petMetrics, placePetPanel } = require('./pet-placement.cjs');
const area = { x: -1280, y: 30, width: 1280, height: 760 };
function inside(rect) {
  assert.ok(rect.x >= area.x && rect.y >= area.y);
  assert.ok(rect.x + rect.width <= area.x + area.width);
  assert.ok(rect.y + rect.height <= area.y + area.height);
}
function disjoint(a, b) {
  assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);
}
test('actions sit above the pet and flip below while edge anchors leave room for living art', () => {
  for (const pet of [
    { x: -220, y: 600 },
    { x: -1250, y: 40 },
  ]) {
    const result = placePetPanel({ area, pet, panel: { kind: 'actions', width: 220, height: 70 } });
    assert.deepEqual(result.pet, {
      ...pet,
      x: Math.max(pet.x, area.x + 32),
      y: Math.max(pet.y, area.y + 18),
      width: 120,
      height: 130,
    });
    inside(result.bounds);
    inside(result.panel);
    disjoint(result.pet, result.panel);
    assert.equal(result.panel.y < pet.y, pet.y === 600);
  }
});
test('right-click menu opens inward, off the face, including all four screen corners', () => {
  for (const x of [-1250, -150])
    for (const y of [40, 630]) {
      const pet = { x, y };
      const result = placePetPanel({
        area,
        pet,
        panel: { kind: 'menu', width: 204, height: 250 },
        pointer: { x: x + 60, y: y + 60 },
      });
      inside(result.bounds);
      inside(result.panel);
      disjoint(result.pet, result.panel);
      assert.equal(result.panel.x > x, x === -1250);
    }
});
test('idle shrinks to a small pet window; large text panel uses the free side', () => {
  const pet = { x: -640, y: 310 };
  const idle = placePetPanel({ area, pet });
  assert.equal(idle.panel, null);
  assert.ok(idle.bounds.width <= 175 && idle.bounds.height <= 160);
  const chat = placePetPanel({ area, pet, panel: { kind: 'chat', width: 320, height: 450 } });
  inside(chat.bounds);
  inside(chat.panel);
  disjoint(chat.pet, chat.panel);
});
test('living pounce keeps its left overhang inside the Host surface without enlarging the hit target', () => {
  for (const x of [-1270, -640, -140]) {
    const result = placePetPanel({ area, pet: { x, y: 310 } });
    inside(result.bounds);
    assert.equal(result.pet.width, 120);
    assert.ok(result.pet.x - result.bounds.x >= 32, '24px art overhang plus 8px window padding');
    assert.ok(result.bounds.width <= 175, 'idle companion remains compact around the full art union');
  }
});

test('the full living-body union stays inside the native surface at every display edge', () => {
  const art = { left: -32, top: -18, right: 142, bottom: 138 };
  for (const anchor of [
    { x: -2000, y: -2000 },
    { x: -640, y: 310 },
    { x: 2000, y: 2000 },
  ]) {
    const result = placePetPanel({ area, pet: anchor });
    inside(result.bounds);
    assert.ok(result.pet.x + art.left >= result.bounds.x, 'left peek/pounce extent is inside');
    assert.ok(result.pet.y + art.top >= result.bounds.y, 'pounce and wake top extent is inside');
    assert.ok(result.pet.x + art.right <= result.bounds.x + result.bounds.width, 'wake right extent is inside');
    assert.ok(result.pet.y + art.bottom <= result.bounds.y + result.bounds.height, 'peek bottom extent is inside');
  }
});

test('saved ball size scales the hit target and full art union on a negative-origin display', () => {
  for (const ballSize of [48, 72, 192]) {
    const metrics = petMetrics(ballSize);
    const result = placePetPanel({
      area,
      ballSize,
      pet: { x: area.x + area.width - 10, y: area.y + area.height - 10 },
      panel: { kind: 'settings', width: 360, height: 478 },
    });
    inside(result.bounds);
    inside(result.panel);
    disjoint(result.pet, result.panel);
    assert.deepEqual({ width: result.pet.width, height: result.pet.height }, metrics.pet);
    assert.ok(result.pet.x - metrics.art.left >= result.bounds.x);
    assert.ok(result.pet.y - metrics.art.top >= result.bounds.y);
    assert.ok(result.pet.x + result.pet.width + metrics.art.right <= result.bounds.x + result.bounds.width);
    assert.ok(result.pet.y + result.pet.height + metrics.art.bottom <= result.bounds.y + result.bounds.height);
  }
});

test('invalid native size input fails closed to the reviewed default geometry', () => {
  assert.deepEqual(petMetrics(Number.NaN), petMetrics(72));
  assert.deepEqual(petMetrics(47), petMetrics(72));
  assert.deepEqual(petMetrics(193), petMetrics(72));
});
