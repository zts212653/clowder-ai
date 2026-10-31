import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { LiveSharedScreen } from '../src/domains/concierge/live/live-shared-screen.js';

test('Host screen grants reject delayed frames after revoke or replacement, retaining trusted source metadata', async () => {
  const screen = await LiveSharedScreen.create(resolve('../../desktop/companion-live'), () => true);
  const frame = {
    image: 'data:image/jpeg;base64,/9j/AA==',
    width: 100,
    height: 100,
    observedAt: Date.now(),
    frameId: 'spoof',
    sourceLabel: 'spoof',
  };
  try {
    screen.open('first', 'Selected window');
    screen.frame('first', frame);
    assert.equal(screen.current()?.sourceLabel, 'Selected window');
    assert.notEqual(screen.current()?.frameId, 'spoof');
    screen.stop();
    assert.equal(screen.current(), undefined);
    assert.throws(() => screen.frame('first', frame), /expired/);
    screen.open('second', 'Other window');
    assert.throws(() => screen.frame('first', frame), /expired/);
    assert.throws(() => screen.frame('second', { ...frame, observedAt: Date.now() - 6000 }), /expired/);
  } finally {
    await screen.close();
  }
  assert.throws(() => screen.open('late', 'late'), /Invalid/);
});
