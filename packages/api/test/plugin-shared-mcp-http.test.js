import assert from 'node:assert/strict';
import test from 'node:test';
import { sharedPluginFixture } from './helpers/shared-plugin-mcp-fixture.js';

test('HTTP uses canonical member grants, independent callers/projects, and contribution-owned tools', async () => {
  const f = await sharedPluginFixture();
  try {
    const ordinary = await f.path();
    const responses = await Promise.all(
      ['a', 'b'].map((project) =>
        f.rpc(project, ordinary, 'tools/call', { name: 'ordinary', arguments: {}, _meta: { catId: 'forged' } }),
      ),
    );
    for (const [index, response] of responses.entries()) {
      assert.equal(response.status, 200, response.text);
      const identity = JSON.parse(response.body.result.content[0].text);
      const project = index === 0 ? 'a' : 'b';
      assert.equal(identity.catId, `f333-${project}`);
      assert.equal(identity.project, f.projects[project]);
    }
    const before = f.calls.length;
    const foreign = await f.rpc('a', ordinary, 'tools/call', { name: 'owner', arguments: {} });
    assert.ok(foreign.body.error || foreign.body.result?.isError);
    assert.equal(f.calls.length, before);
    await f.setBlocked('a', ['f333-a']);
    assert.notEqual((await f.rpc('a', ordinary)).status, 200, 'guessing an HTTP URL cannot bypass blockedCats');
    assert.equal((await f.rpc('b', ordinary)).status, 200);
    await f.setBlocked('a');
    Object.assign(f.records.a, { toolExecutionPolicy: { mode: 'read_only', replayDeniedToolNames: [] } });
    assert.notEqual((await f.rpc('a', ordinary)).status, 200);
  } finally {
    await f.close();
  }
});
test('queued revocation and configuration refresh reject old results and old discovery URLs', async () => {
  const f = await sharedPluginFixture();
  try {
    const old = await f.path();
    const pending = f.wait('ordinary_slow', 'a');
    const response = f.rpc('a', old, 'tools/call', { name: 'ordinary_slow', arguments: {} });
    await pending.ready;
    await f.setBlocked('a', ['f333-a']);
    pending.release();
    const revoked = await response;
    assert.equal(revoked.body.result.isError, true);
    assert.ok(!revoked.text.includes('thread-a'));
    await f.setBlocked('a');
    f.refresh();
    assert.notEqual((await f.rpc('a', old)).status, 200);
    const fresh = await f.path();
    assert.notEqual(old, fresh);
    assert.equal((await f.rpc('a', fresh)).status, 200);
    f.actions.deactivate('instance');
    assert.notEqual((await f.rpc('a', fresh)).status, 200);
    f.activate();
    f.refresh();
    assert.equal((await f.rpc('a', await f.path())).status, 200);
  } finally {
    await f.close();
  }
});
test('same request IDs in two contributions cancel independently and release request resources', async () => {
  const f = await sharedPluginFixture();
  try {
    const ordinary = await f.path();
    const owner = await f.path('owner');
    const a = f.wait('ordinary_slow', 'a');
    const b = f.wait('owner_slow', 'a');
    const first = f.rpc('a', ordinary, 'tools/call', { name: 'ordinary_slow', arguments: {} });
    const second = f.rpc('a', owner, 'tools/call', { name: 'owner_slow', arguments: {} });
    await Promise.all([a.ready, b.ready]);
    assert.equal((await f.rpc('a', ordinary, 'notifications/cancelled', { requestId: 1 }, undefined)).status, 202);
    const cancelled = await first;
    assert.equal(cancelled.body.result.isError, true);
    b.release();
    const unaffected = await second;
    assert.equal(unaffected.body.result.isError, undefined);
    a.release();
    assert.equal((await f.rpc('a', ordinary)).status, 200, 'the old request ID has been released');
  } finally {
    await f.close();
  }
});
