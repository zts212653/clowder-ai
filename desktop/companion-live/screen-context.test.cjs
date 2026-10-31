const assert = require('node:assert/strict');
const { test } = require('node:test');
const { ScreenContext } = require('./screen-context.cjs');
const frame = { image: 'data:image/jpeg;base64,/9j/AA==', width: 640, height: 480 };

test('screen frames require the exact active user selection and expire honestly', () => {
  let now = 1000;
  const context = new ScreenContext({ now: () => now });
  assert.equal(context.accept('anything', frame), false);
  const selected = context.request();
  assert.equal(context.accept(selected, frame), false);
  assert.equal(context.start(selected, 'Chosen window'), true);
  assert.equal(context.accept('different-selection', frame), false);
  assert.equal(context.accept(selected, frame), true);
  assert.equal(context.current().observedAt, 1000);
  assert.equal(context.current().sourceLabel, 'Chosen window');
  now = 6001;
  assert.equal(context.current(), undefined);
});

test('revocation invalidates pending picker, cached image and late frames', () => {
  const context = new ScreenContext();
  const abandoned = context.request();
  context.stop();
  assert.equal(context.start(abandoned, 'Late picker'), false);
  const current = context.request();
  context.start(current, 'New source');
  context.accept(current, frame);
  context.stop();
  assert.equal(context.current(), undefined);
  assert.equal(context.accept(current, frame), false);
  assert.equal(context.start(current, 'Late retry'), false);
});

test('frame payload is bounded, image-only and cannot supply authoritative timestamps', () => {
  const context = new ScreenContext({ now: () => 2000 });
  const selected = context.request();
  context.start(selected, 'Window');
  for (const invalid of [
    { ...frame, image: 'https://example.com/image.jpg' },
    { ...frame, image: `data:image/jpeg;base64,/9j/${'A'.repeat(1_400_000)}` },
    { ...frame, width: 1601 },
    { ...frame, height: 0 },
    { ...frame, width: 1.5 },
  ])
    assert.equal(context.accept(selected, invalid), false);
  assert.equal(context.accept(selected, { ...frame, observedAt: 999999, sourceLabel: 'Spoof' }), true);
  assert.equal(context.current().observedAt, 2000);
  assert.equal(context.current().sourceLabel, 'Window');
});
