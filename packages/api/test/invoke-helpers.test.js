/**
 * Issue #98: isSessionToxic() — detect toxic sessions before resume.
 * Unit tests for the pure helper function.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

async function loadModule() {
  return import('../dist/domains/cats/services/agents/invocation/invoke-helpers.js');
}

describe('isSessionToxic()', () => {
  test('compressionCount=5, messageCount=0 → toxic (BUG-001 pattern)', async () => {
    const { isSessionToxic } = await loadModule();
    assert.equal(isSessionToxic({ compressionCount: 5, messageCount: 0 }), true);
  });

  test('compressionCount=30, messageCount=0 → toxic (extreme BUG-001)', async () => {
    const { isSessionToxic } = await loadModule();
    assert.equal(isSessionToxic({ compressionCount: 30, messageCount: 0 }), true);
  });

  test('compressionCount=10, messageCount=5 → toxic (unconditional cap)', async () => {
    const { isSessionToxic } = await loadModule();
    assert.equal(isSessionToxic({ compressionCount: 10, messageCount: 5 }), true);
  });

  test('compressionCount=15, messageCount=100 → toxic (cap overrides message count)', async () => {
    const { isSessionToxic } = await loadModule();
    assert.equal(isSessionToxic({ compressionCount: 15, messageCount: 100 }), true);
  });

  test('compressionCount=3, messageCount=0 → not toxic (below threshold)', async () => {
    const { isSessionToxic } = await loadModule();
    assert.equal(isSessionToxic({ compressionCount: 3, messageCount: 0 }), false);
  });

  test('compressionCount=4, messageCount=10 → not toxic (healthy session)', async () => {
    const { isSessionToxic } = await loadModule();
    assert.equal(isSessionToxic({ compressionCount: 4, messageCount: 10 }), false);
  });

  test('compressionCount=0, messageCount=0 → not toxic (fresh session)', async () => {
    const { isSessionToxic } = await loadModule();
    assert.equal(isSessionToxic({ compressionCount: 0, messageCount: 0 }), false);
  });

  test('compressionCount=9, messageCount=20 → not toxic (just below cap)', async () => {
    const { isSessionToxic } = await loadModule();
    assert.equal(isSessionToxic({ compressionCount: 9, messageCount: 20 }), false);
  });

  test('undefined compressionCount → not toxic (defaults to 0)', async () => {
    const { isSessionToxic } = await loadModule();
    assert.equal(isSessionToxic({ compressionCount: undefined, messageCount: 0 }), false);
  });

  test('undefined messageCount → not toxic when compressionCount low', async () => {
    const { isSessionToxic } = await loadModule();
    assert.equal(isSessionToxic({ compressionCount: 3, messageCount: undefined }), false);
  });

  test('undefined compressionCount with undefined messageCount → not toxic', async () => {
    const { isSessionToxic } = await loadModule();
    assert.equal(isSessionToxic({ compressionCount: undefined, messageCount: undefined }), false);
  });

  test('compressionCount=5, undefined messageCount → toxic (defaults mc to 0)', async () => {
    const { isSessionToxic } = await loadModule();
    assert.equal(isSessionToxic({ compressionCount: 5, messageCount: undefined }), true);
  });

  // Edge: exactly at boundary
  test('compressionCount=5, messageCount=1 → not toxic (has output)', async () => {
    const { isSessionToxic } = await loadModule();
    assert.equal(isSessionToxic({ compressionCount: 5, messageCount: 1 }), false);
  });

  test('compressionCount=10, messageCount=0 → toxic (both patterns match)', async () => {
    const { isSessionToxic } = await loadModule();
    assert.equal(isSessionToxic({ compressionCount: 10, messageCount: 0 }), true);
  });
});
