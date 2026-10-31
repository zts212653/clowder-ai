const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, readdirSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');
const { saveSyntheticMedia } = require('./synthetic-audio.cjs');

test('synthetic media evidence contains only bounded transport facts, never transcript or credentials', () => {
  const root = mkdtempSync(join(tmpdir(), 'f317-synthetic-media-'));
  try {
    saveSyntheticMedia(root, { type: 'media', synthetic: false });
    assert.deepEqual(readdirSync(root), []);
    saveSyntheticMedia(root, {
      type: 'media',
      synthetic: true,
      microphoneCaptured: false,
      connection: 'connected',
      playback: { outputCreated: true, paused: false, muted: false },
      inbound: [{ bytesReceived: 2048, totalAudioEnergy: 0.12, secret: 'not-retained' }],
      text: 'not-retained',
      token: 'not-retained',
    });
    const raw = readFileSync(join(root, 'synthetic-media.json'), 'utf8');
    assert.equal(raw.includes('not-retained'), false);
    const receipt = JSON.parse(raw);
    assert.equal(receipt.playbackStarted, true);
    assert.equal(receipt.microphoneCaptured, false);
    assert.deepEqual(receipt.inbound, [{ bytesReceived: 2048, totalAudioEnergy: 0.12 }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
