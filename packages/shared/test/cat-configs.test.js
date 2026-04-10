import assert from 'node:assert/strict';
import test from 'node:test';
import { CAT_CONFIGS } from '../dist/index.js';

test('CAT_CONFIGS exposes first-class kimi fallback cat', () => {
  assert.equal(CAT_CONFIGS.kimi?.clientId, 'kimi');
  assert.equal(CAT_CONFIGS.kimi?.avatar, '/avatars/kimi.png');
  assert.equal(CAT_CONFIGS.kimi?.displayName, '梵花猫');
  assert.equal(CAT_CONFIGS.kimi?.breedId, 'moonshot');
});
