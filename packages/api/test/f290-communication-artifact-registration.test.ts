import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerCallbackTaskRoutes } from '../src/routes/callback-task-routes.js';
import { documentWriterFixture } from './f290-communication-document-writer.fixture.js';
import { CAT } from './f290-communication-validation.host.js';

/** Real admitted Work, Registry authority checks and canonical Task lifecycle; no model or fake task mutation. */
async function fixture() {
  const f = await documentWriterFixture();
  registerCallbackTaskRoutes(f.app, {
    taskStore: f.tasks,
    threadStore: f.threads,
    messageStore: f.messages,
    socketManager: { broadcastToRoom() {}, emitToUser() {} } as never,
  });
  const register = (payload: Record<string, unknown>, auth = f.auth) =>
    f.app.inject({
      method: 'POST',
      url: '/api/callbacks/update-entrusted-work',
      headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
      payload,
    });
  return { ...f, register };
}

test('current private Work registers generated Artifact refs through canonical CAS without changing its admission or closure', async () => {
  const f = await fixture();
  try {
    const generated = await f.post({ markdown: '# Work result\n', format: 'md', baseName: 'result' });
    assert.equal(generated.statusCode, 200, generated.body);
    const before = await f.tasks.get(f.task.id);
    assert.ok(before?.entrustedWork);
    const command = {
      taskId: f.task.id,
      expectedRevision: before.entrustedWork.revision,
      artifactRefs: [generated.json().url],
    };
    const result = await f.register(command);
    assert.equal(result.statusCode, 200, result.body);
    const current = await f.tasks.get(f.task.id);
    assert.deepEqual(current?.entrustedWork?.artifactRefs, command.artifactRefs);
    assert.deepEqual(current?.entrustedWork?.admission, before.entrustedWork.admission);
    assert.deepEqual(current?.entrustedWork?.closure, before.entrustedWork.closure);
    assert.equal(current?.ownerCatId, before.ownerCatId);
    assert.equal(current?.entrustedWork?.revision, before.entrustedWork.revision + 1);
    const stale = await f.register(command);
    assert.equal(stale.statusCode, 409, stale.body);
    assert.deepEqual((await f.tasks.get(f.task.id))?.entrustedWork?.artifactRefs, command.artifactRefs);
    const verified = await f.registry.verify(f.auth.invocationId, f.auth.callbackToken);
    assert.ok(verified.ok, 'Artifact CAS does not invalidate the same current execution');
    assert.equal((await f.context.current(verified.record)).authority, 'owner_admitted_work');
  } finally {
    await f.close();
  }
});

test('same-Task named delegate can register its current publication without taking ownership', async () => {
  const f = await fixture();
  try {
    const relay = await f.relayAuth();
    const generated = await f.post({ markdown: '# Relay result\n', format: 'md', baseName: 'relay' }, relay);
    assert.equal(generated.statusCode, 200, generated.body);
    const before = await f.tasks.get(f.task.id);
    assert.ok(before?.entrustedWork);
    const result = await f.register(
      {
        taskId: f.task.id,
        expectedRevision: before.entrustedWork.revision,
        artifactRefs: [generated.json().url],
      },
      relay,
    );
    assert.equal(result.statusCode, 200, result.body);
    const current = await f.tasks.get(f.task.id);
    assert.equal(current?.ownerCatId, CAT);
    assert.deepEqual(current?.entrustedWork?.admission, before.entrustedWork.admission);
    assert.deepEqual(current?.entrustedWork?.closure, before.entrustedWork.closure);
  } finally {
    await f.close();
  }
});

test('Artifact registration cannot mutate sibling Tasks, progress, deadlines, admission or closure and public Cats have no updater', async () => {
  const f = await fixture();
  try {
    const before = await f.tasks.get(f.task.id);
    assert.ok(before?.entrustedWork);
    const command = { taskId: f.task.id, expectedRevision: before.entrustedWork.revision, artifactRefs: [] };
    for (const input of [
      { ...command, taskId: 'another-task' },
      { ...command, status: 'done' },
      { ...command, status: 'doing' },
      { ...command, time: { deadline: null } },
      { ...command, progress: null },
      { ...command, closure: { state: 'satisfied' } },
      { ...command, admission: before.entrustedWork.admission },
    ]) {
      const denied = await f.register(input);
      assert.equal(denied.statusCode, 403, denied.body);
    }
    const publicDenied = await f.register(command, await f.publicAuth());
    assert.equal(publicDenied.statusCode, 403, publicDenied.body);
    assert.deepEqual(await f.tasks.get(f.task.id), before);
    await f.cafe.connector.revoke(f.cafe.connectionId);
    const revoked = await f.register({ ...command, artifactRefs: ['/uploads/withdrawn.md'] });
    assert.notEqual(revoked.statusCode, 200, revoked.body);
    assert.deepEqual(await f.tasks.get(f.task.id), before);
  } finally {
    await f.close();
  }
});

test('native private Work refuses arbitrary and other-Task Artifact coordinates before canonical CAS', async () => {
  const f = await fixture();
  try {
    const before = await f.tasks.get(f.task.id);
    assert.ok(before?.entrustedWork);
    for (const artifactRef of [
      '/uploads/private-owner.md',
      '/uploads/cwork-' + 'a'.repeat(32) + '-' + 'b'.repeat(64) + '.md',
    ]) {
      const result = await f.register({
        taskId: f.task.id,
        expectedRevision: before.entrustedWork.revision,
        artifactRefs: [artifactRef],
      });
      assert.equal(result.statusCode, 403, result.body);
    }
    assert.deepEqual((await f.tasks.get(f.task.id))?.entrustedWork, before.entrustedWork);
  } finally {
    await f.close();
  }
});
