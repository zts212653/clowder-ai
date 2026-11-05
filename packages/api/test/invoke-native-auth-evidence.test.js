import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runNativeAuthContinuation as run } from './helpers/native-auth-continuation-fixture.js';

for (const mode of [
  'unknown-step',
  'anonymous-completion',
  'unnamed-tool',
  'blank-tool',
  'missing-step-index',
  'fractional-step-index',
  'changed-tool-name',
  'changed-step-type',
  'missing-step-owner',
  'unfinished-agent-step',
  'foreign-terminal-owner',
  'missing-terminal-owner',
  'missing-event',
  'unknown-event',
  'malformed-json',
  'scalar-event',
]) {
  test(`Native auth continuation requires unfiltered owned completion evidence: ${mode}`, async () => {
    const f = await run(mode);
    assert.equal(f.calls, 1, 'ambiguous evidence must not authorize a successor');
    assert.equal(f.writes.length, 1);
    assert.ok(f.messages.some((message) => message.type === 'error'));
    assert.equal(f.effects.includes('B'), false);
    assert.equal(f.events.filter((event) => event.type === 'request_generation_assembled').length, 1);
  });
}

test('a known host liveness observation does not invalidate Native completion evidence', async () => {
  const f = await run('liveness-warning');
  assert.equal(f.calls, 2);
  assert.equal(f.effects, 'A\nB\n');
  assert.equal(
    f.messages.some((message) => message.type === 'error'),
    false,
  );
});
