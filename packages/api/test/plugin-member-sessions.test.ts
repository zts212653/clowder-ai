import assert from 'node:assert/strict';
import test from 'node:test';
import { createPluginMemberSessions } from '../src/domains/plugin/member-sessions/service.js';
import type { MemberSessionRecord } from '../src/domains/plugin/member-sessions/types.js';
import { memberSessionFixture as fixture } from './helpers/plugin-member-session-fixture.js';

test('a serialized approval cannot prepare a member, while the typed owner request freezes only references', async () => {
  const f = fixture(),
    port = f.bind();
  await assert.rejects(() => port.prepare({ ...f.prepareInput, approved: true } as never), /owner|approval/);
  const session = await f.owner(() => port.prepare(f.prepareInput));
  assert.equal(session.catId, 'member');
  assert.equal(session.runtime.account.accountRef, 'existing-oauth');
  const persisted = JSON.stringify([...f.rows.values()]);
  assert.equal(persisted.includes('主人给我的真实名字'), false, 'source content belongs to its original owner');
  assert.equal(persisted.includes('callbackToken'), false);
});

test('a canceled original source cannot be awakened again while its admission ACK is unknown', async () => {
  const f = fixture(),
    port = f.bind();
  const session = await f.owner(() => port.prepare(f.prepareInput));
  const input = {
    sessionId: session.sessionId,
    generation: session.generation,
    executionId: 'event',
    semanticCursor: 1,
    content: '局部事件',
  };
  f.loseAck();
  await assert.rejects(() => port.execute(input), /ack_lost/);
  f.cancelOriginal();
  await assert.rejects(() => port.execute(input), /canceled|unconfirmed/);
  assert.equal(f.attempts(), 1, 'cancellation is not a reason to resend or wake');
});

test('a lost execution admission ACK reopens the original permanent message without another wake', async () => {
  const f = fixture();
  let port = f.bind();
  const session = await f.owner(() => port.prepare(f.prepareInput));
  const execution = {
    sessionId: session.sessionId,
    generation: session.generation,
    executionId: 'semantic-event-1',
    semanticCursor: 2,
    content: '本人观察到了附近的新物件。',
  };
  f.loseAck();
  await assert.rejects(() => port.execute(execution), /ack_lost/);
  port = f.bind();
  const recovered = await port.execute(execution);
  assert.equal(recovered.messageId, 'canonical-trigger');
  assert.equal(recovered.phase, 'queued');
  assert.equal(f.sends(), 1);
  await assert.rejects(() => port.execute({ ...execution, content: '另一个事件冒用同一执行号' }), /conflict/);
});

test('an account revision or installation change rejects the queued work before another send', async () => {
  const f = fixture(),
    port = f.bind();
  const session = await f.owner(() => port.prepare(f.prepareInput));
  f.changeAccount();
  await assert.rejects(
    () =>
      port.execute({
        sessionId: session.sessionId,
        generation: session.generation,
        executionId: 'event',
        semanticCursor: 1,
        content: '局部事件',
      }),
    /runtime.*changed/,
  );
  assert.equal(f.sends(), 0);
  f.revokeInstallation();
  await assert.rejects(() => port.get(session.sessionId), /installation_revoked/);
});

test('owner revocation persists across Host recreation and invalidates the original queued execution', async () => {
  const f = fixture(),
    port = f.bind();
  const session = await f.owner(() => port.prepare(f.prepareInput));
  const input = {
    sessionId: session.sessionId,
    generation: session.generation,
    executionId: 'event',
    semanticCursor: 1,
    content: '局部事件',
  };
  await port.execute(input);
  await f.owner(() => port.revoke(session.sessionId));
  await assert.rejects(() => f.bind().execute(input), /revoked/);
  assert.equal(f.sends(), 1);
});

test('a fresh authenticated owner can regrant after upgrade without resurrecting the old package generation', async () => {
  const f = fixture(),
    original = f.bind();
  const first = await f.owner(() => original.prepare(f.prepareInput));
  await assert.rejects(() => f.owner(() => original.prepare(f.prepareInput), 'unnecessary-rebind'), /already_prepared/);
  const upgraded = f.bind('package-v2');
  await assert.rejects(() => upgraded.prepare(f.prepareInput), /owner_authority/);
  const next = await f.owner(() => upgraded.prepare(f.prepareInput), 'fresh-upgrade-request');
  assert.equal(next.sessionId, first.sessionId);
  assert.equal(next.generation, first.generation + 1);
  assert.equal(next.packageDigest, 'package-v2');
  const stored = await f.deps.storage.get('grant-history', `${first.sessionId}:${first.generation}`);
  assert.ok(stored);
  const { grant } = stored.value as { grant: MemberSessionRecord };
  assert.equal(grant.packageDigest, first.packageDigest);
  assert.equal(grant.generation, first.generation);
  await assert.rejects(
    () =>
      original.execute({
        sessionId: first.sessionId,
        generation: first.generation,
        executionId: 'stale-event',
        semanticCursor: 1,
        content: '旧版本事件',
      }),
    /scope_mismatch/,
  );
  assert.equal(f.sends(), 0);
});

test('an explicit owner regrant can reuse an execution id without adopting the prior generation message', async () => {
  const f = fixture(),
    port = f.bind();
  const first = await f.owner(() => port.prepare(f.prepareInput));
  const input = {
    sessionId: first.sessionId,
    generation: first.generation,
    executionId: 'local-event-1',
    semanticCursor: 1,
    content: '同一条本人局部事件',
  };
  const original = await port.execute(input);
  await f.owner(() => port.revoke(first.sessionId));
  const replacement = await f.owner(() => port.prepare(f.prepareInput), 'fresh-owner-regrant');
  const next = { ...input, generation: replacement.generation };
  const admitted = await port.execute(next);
  assert.notEqual(admitted.messageId, original.messageId);
  assert.equal(f.sends(), 2);
  assert.equal((await port.execute(next)).messageId, admitted.messageId);
  assert.equal(f.sends(), 2);
});

for (const stage of ['lookup', 'sender-admission'] as const) {
  test(`regrant during ${stage} rejects the old generation before any send or wake`, async () => {
    const f = fixture();
    let replaced = false;
    let port: ReturnType<typeof f.bind>;
    let sessionId: string;
    const regrant = async () => {
      if (replaced) return;
      replaced = true;
      await f.owner(() => port.revoke(sessionId));
      await f.owner(() => port.prepare(f.prepareInput), `owner-regrant-${stage}`);
    };
    port = createPluginMemberSessions({
      ...f.deps,
      messaging: {
        ...f.deps.messaging,
        findSent: async (input) => {
          if (stage === 'lookup') await regrant();
          return f.deps.messaging.findSent(input);
        },
        send: async (input, scope) => {
          if (stage === 'sender-admission') await regrant();
          await scope.assertCurrent();
          return f.deps.messaging.send(input);
        },
      },
    }).forInstance(f.scope());
    const first = await f.owner(() => port.prepare(f.prepareInput));
    sessionId = first.sessionId;
    await assert.rejects(
      () =>
        port.execute({
          sessionId,
          generation: first.generation,
          executionId: 'local-change',
          semanticCursor: 1,
          content: '旧代次事件',
        }),
      /generation_changed/,
    );
    assert.equal(f.sends(), 0);
    assert.equal(f.attempts(), 0);
    assert.equal((await port.get(sessionId))?.generation, first.generation + 1);
  });
}
