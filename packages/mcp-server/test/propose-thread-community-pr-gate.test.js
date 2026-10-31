import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('F128 community PR cognitive guard', () => {
  test('tool description documents that the server does not infer PR identity or auto-inject policy', async () => {
    const { createServer } = await import('../dist/index.js');
    const tool = createServer()._registeredTools.cat_cafe_propose_thread;

    assert.ok(tool, 'cat_cafe_propose_thread must be registered');
    assert.doesNotMatch(tool.description, /server (?:auto-)?injects/i);
    assert.doesNotMatch(tool.description, /maintainer (?:five questions|五问)/i);
    assert.doesNotMatch(tool.description, /real GitHub author/i);
    assert.doesNotMatch(tool.description, /FORMAL EXTERNAL PR OUTPUT/i);
    assert.doesNotMatch(tool.description, /does NOT auto-register a wait/i);
    assert.match(tool.description, /opensource-ops/);
    assert.match(tool.description, /does NOT infer external PR identity/i);
    assert.match(tool.description, /child thread.*load.*opensource-ops/i);
  });
});
