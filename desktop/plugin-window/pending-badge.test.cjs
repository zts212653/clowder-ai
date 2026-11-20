// F336 Phase C: the Host's mirror of the panel's pending badge (decision-view.mjs decisionBadge and
// style.css #pending-badge of @clowder-ai/companion 0.1.0-alpha.38).
const assert = require('node:assert/strict');
const test = require('node:test');
const { badgeLabel, createPendingBadge, shareBadgeRect } = require('./pending-badge.cjs');

const unified = (fields) => ({ kind: 'decisions', version: 1, status: 'available', items: [], ...fields });

test('the label follows decisionBadge: hidden only on a complete empty read', () => {
  const rows = [{ kind: 'approval' }];
  assert.equal(badgeLabel(undefined), '?', 'a failed read');
  assert.equal(badgeLabel(unified({ totalCount: 0 })), null);
  assert.equal(badgeLabel(unified({ totalCount: 12 })), '12');
  assert.equal(badgeLabel(unified({ status: 'partial', items: rows })), '•');
  assert.equal(badgeLabel(unified({ status: 'partial' })), '!');
  assert.equal(badgeLabel(unified({ status: 'unavailable' })), '!');
  assert.equal(badgeLabel(unified({ items: rows })), '•', 'a count that is not exact');
  assert.equal(badgeLabel(unified({})), '!');
  const legacy = { kind: 'decisions', status: 'available', approvals: [], otherNeedsMe: [] };
  assert.equal(badgeLabel(legacy), null);
  assert.equal(badgeLabel({ ...legacy, needsMeCount: 2 }), '有待办');
  assert.equal(badgeLabel({ ...legacy, approvals: rows }), '有待办');
  assert.equal(badgeLabel({ ...legacy, status: 'unavailable' }), '?');
});

test('the rect sits at the top right of the scaled anchor box, inside the panel window, sized by its label', () => {
  const badge = createPendingBadge();
  const layout = { pet: { x: 600, y: 600 }, bounds: { x: 600, y: 600, width: 300, height: 70 } };
  assert.equal(badge.rect(layout, 72), null, 'nothing is shown before the first read');
  badge.observe({ kind: 'decisions.read' }, unified({ totalCount: 3 }));
  assert.equal(badge.rect(layout, 72), null, 'nor before settings say quiet-badge');
  badge.observe(
    { kind: 'settings.read' },
    { kind: 'settings', status: 'available', values: { proactivePolicy: 'quiet-badge' } },
  );
  assert.deepEqual(badge.rect(layout, 72), { x: 695, y: 600, width: 25, height: 24 });
  assert.deepEqual(badge.rect(layout, 144), { x: 815, y: 600, width: 25, height: 24 }, 'the anchor box scales');
  badge.observe({ kind: 'decisions.read' }, { kind: 'decisions', status: 'available', needsMeCount: 1 });
  assert.deepEqual(badge.rect(layout, 72), { x: 669, y: 600, width: 51, height: 24 }, '有待办 is wider');
  const narrow = { ...layout, bounds: { x: 600, y: 600, width: 100, height: 70 } };
  assert.deepEqual(badge.rect(narrow, 72), { x: 669, y: 600, width: 31, height: 24 }, 'clipped to the window');
  assert.equal(badge.rect({ ...layout, bounds: { ...narrow.bounds, width: 60 } }, 72), null, 'outside the window');
  badge.observe({ kind: 'state' }, { kind: 'state', phase: 'idle' });
  assert.notEqual(badge.rect(layout, 72), null, 'other replies change nothing');
});

test('docked at the right edge the pending badge moves to the left of the anchor, like the page draws it', () => {
  const badge = createPendingBadge();
  badge.observe({ kind: 'decisions.read' }, unified({ totalCount: 3 }));
  badge.observe(
    { kind: 'settings.read' },
    { kind: 'settings', status: 'available', values: { proactivePolicy: 'quiet-badge' } },
  );
  // anchor 120 px wide at x 1000; the work area ends at 1150: 30 px from the edge (<= 40) = docked right
  const layout = { pet: { x: 1000, y: 600 }, bounds: { x: 900, y: 500, width: 260, height: 300 } };
  const area = { x: 0, y: 0, width: 1150, height: 900 };
  assert.deepEqual(badge.rect(layout, 72, area), { x: 1000, y: 600, width: 25, height: 24 });
  const open = { x: 0, y: 0, width: 1400, height: 900 };
  assert.deepEqual(badge.rect(layout, 72, open), { x: 1095, y: 600, width: 25, height: 24 }, 'not docked: top right');
});

test('the stop-sharing badge: shown while sharing or picking, 32 px at the anchor bottom right, left when docked right', () => {
  const layout = { pet: { x: 600, y: 600 }, bounds: { x: 600, y: 600, width: 300, height: 200 } };
  const area = { x: 0, y: 0, width: 1400, height: 900 };
  assert.equal(shareBadgeRect(layout, 72, area, false), null, 'not shown without a share or a pick');
  // anchor box 120 x 130 at ballSize 72: bottom right corner (720, 730)
  assert.deepEqual(shareBadgeRect(layout, 72, area, true), { x: 688, y: 698, width: 32, height: 32 });
  const tall = { ...layout, bounds: { ...layout.bounds, height: 250 } };
  // anchor box 240 x 260 at ballSize 144: bottom right (840, 860); the window ends at y 850
  assert.deepEqual(
    shareBadgeRect(tall, 144, area, true),
    { x: 808, y: 828, width: 32, height: 22 },
    'the anchor box scales; clipped to the window',
  );
  assert.equal(shareBadgeRect(layout, 144, area, true), null, 'entirely below the window: nothing');
  const docked = { width: 735, x: 0, y: 0, height: 900 };
  assert.deepEqual(shareBadgeRect(layout, 72, docked, true), { x: 600, y: 698, width: 32, height: 32 }, 'docked right');
});
