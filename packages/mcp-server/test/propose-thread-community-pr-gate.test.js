import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('F128 community PR cognitive guard', () => {
  test('tool description documents the server-injected maintainer gate', async () => {
    const { createServer } = await import('../dist/index.js');
    const tool = createServer()._registeredTools.cat_cafe_propose_thread;

    assert.ok(tool, 'cat_cafe_propose_thread must be registered');
    assert.match(tool.description, /clowder-ai PR/i);
    assert.match(tool.description, /server (?:auto-)?injects/i);
    assert.match(tool.description, /opensource-ops/);
    assert.match(tool.description, /maintainer (?:five questions|五问)/i);
    assert.match(tool.description, /GitHub author/i);
    assert.match(tool.description, /human_participant_activity/);
    assert.match(tool.description, /advisory, triage, arbitrary-link/i);
    assert.match(tool.description, /exactly one preferredCat/i);
  });
});
