import assert from 'node:assert/strict';
import test from 'node:test';
import { CAT_CONFIGS } from '../dist/index.js';

test('CAT_CONFIGS exposes first-class kimi and omx fallback cats', () => {
  assert.equal(CAT_CONFIGS.kimi?.provider, 'kimi');
  assert.equal(CAT_CONFIGS.kimi?.avatar, '/avatars/kimi.png');
  assert.equal(CAT_CONFIGS.kimi?.displayName, '金吉拉');
  assert.equal(CAT_CONFIGS.kimi?.breedId, 'moonshot');
  assert.equal(CAT_CONFIGS.omx?.provider, 'omx');
  assert.equal(CAT_CONFIGS.omx?.avatar, '/avatars/omx.png');
  assert.equal(CAT_CONFIGS.omx?.displayName, '曼岛猫');
  assert.equal(CAT_CONFIGS.omx?.breedId, 'orchestrator');
});
