import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { LivingWorkService } from '../src/domains/collaborative-content/works/service.js';
import { htmlCreate, htmlFixture } from './helpers/living-work-html-fixture.js';

for (const provenance of ['unknown', 'compatibility_fallback'] as const) {
  test(`${provenance}: current callback reads retained work but cannot independently produce`, async (t) => {
    const f = await htmlFixture(t);
    const first = await f.service.commit(htmlCreate, f.principal);
    const auth = await f.registry.create(
      'operator',
      createCatId('codex-astra'),
      'thread-cover',
      undefined,
      undefined,
      undefined,
      undefined,
      provenance,
    );
    const headers = { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken };
    assert.equal((await f.call({ action: 'list' }, {})).statusCode, 401);
    for (const command of [
      { action: 'list' },
      { action: 'read', reference: first.reference },
      { action: 'read-body', reference: first.reference },
    ]) {
      const result = await f.call(command, headers);
      assert.equal(result.statusCode, 200, result.body);
    }
    assert.equal((await f.call(htmlCreate, headers)).statusCode, 403);
    const submit = {
      ...htmlCreate,
      action: 'submit',
      operationId: 'resumed-without-grant',
      contentRef: first.reference.contentRef,
      expectedOwnerRevision: 1,
      source: { kind: 'html', html: '<p>changed</p>' },
    };
    assert.equal((await f.call(submit, headers)).statusCode, 403);
    assert.equal((await f.call(submit, headers, { contentTaskId: 'invented' })).statusCode, 403);
    assert.equal((await f.owner.describe(first.reference.contentRef)).currentOwnerRevision, 1);
    await f.registry.commitTerminal({
      invocationId: auth.invocationId,
      disposition: 'completed',
      endedAt: Date.now(),
      endReason: 'test ended',
    });
    assert.equal((await f.call({ action: 'list' }, headers)).statusCode, 401);
  });
}

test('read permission still requires the current callback identity and tool policy', async (t) => {
  const f = await htmlFixture(t);
  for (const input of [
    { userId: 'foreign', threadId: 'thread-cover' },
    { userId: 'operator', threadId: 'other-thread' },
    { userId: 'operator', threadId: 'thread-cover', policy: { mode: 'read_only' as const, replayDeniedToolNames: [] } },
  ]) {
    const auth = await f.registry.create(
      input.userId,
      createCatId('codex-sol'),
      input.threadId,
      undefined,
      undefined,
      input.policy,
      undefined,
      'unknown',
    );
    const result = await f.call(
      { action: 'list' },
      { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
    );
    assert.equal(result.statusCode, 403, result.body);
  }
});

test('explicit Task context cannot fall back to the strict original author when its grant is absent', async (t) => {
  const f = await htmlFixture(t);
  const first = await f.service.commit(htmlCreate, f.principal);
  const result = await f.call(
    {
      ...htmlCreate,
      action: 'submit',
      operationId: 'invalid-task-context',
      contentRef: first.reference.contentRef,
      expectedOwnerRevision: 1,
      source: { kind: 'html', html: '<p>changed</p>' },
    },
    f.headers,
    { contentTaskId: 'invented' },
  );
  assert.equal(result.statusCode, 403, result.body);
  assert.equal((await f.owner.describe(first.reference.contentRef)).currentOwnerRevision, 1);
});

test('source inspection uses read permission and rechecks revocation after the source read', async (t) => {
  const f = await htmlFixture(t);
  let reads = 0;
  let revoked = false;
  const service = new LivingWorkService({
    ...f.deps,
    authorize: async ({ permission }) => {
      assert.equal(permission, 'read', 'inspecting an original must not require production authority');
      reads++;
      if (revoked) throw new Error('source authority revoked');
    },
    source: {
      ...f.deps.source,
      inspect: async ({ locator }) => {
        revoked = true;
        return {
          source: { ...locator, expectedSourceRevision: `sha256:${'a'.repeat(64)}` },
          mediaType: 'image/svg+xml',
          byteLength: 10,
        };
      },
    },
  });
  await assert.rejects(
    service.inspectSource({ worktreeId: 'root', path: 'original.svg' }, f.principal),
    /source authority revoked/,
  );
  assert.equal(reads, 2);
});
