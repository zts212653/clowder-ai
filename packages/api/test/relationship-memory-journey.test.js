import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { SessionMutex } from '../dist/domains/cats/services/agents/invocation/SessionMutex.js';
import { approveProfileUpdate } from '../dist/domains/cats/services/profile/approveProfileUpdate.js';
import { FileProfileRepository } from '../dist/domains/cats/services/profile/ProfileRepository.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { InMemoryProfileUpdateProposalStore } from '../dist/domains/cats/services/stores/ports/ProfileUpdateProposalStore.js';
import { ProfileMemoryLifecycleStore } from '../dist/domains/memory/profile/ProfileMemoryLifecycleStore.js';
import { applyMigrations } from '../dist/domains/memory/schema.js';
import { registerCallbackAuthHook } from '../dist/routes/callback-auth-prehandler.js';
import { registerCallbackMessageReadRoutes } from '../dist/routes/callback-message-read-routes.js';
import { registerCallbackProposeProfileUpdateRoutes } from '../dist/routes/callback-propose-profile-update-routes.js';
import { registerCallbackReadProfileRoutes } from '../dist/routes/callback-read-profile-routes.js';
import { canonicalTestMessageInput } from './helpers/message-from-fixtures.js';

test('F321 new agreement: propose → approve → fresh context → original dialogue → correct → forget → revoked scope', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'f321-relationship-journey-'));
  const mapping = { 'codex-sol': 'maine-coon', codex: 'maine-coon', opus: 'ragdoll' };
  const repository = new FileProfileRepository({ dataDir, relationshipKeyForCat: (id) => mapping[id] });
  const proposalStore = new InMemoryProfileUpdateProposalStore();
  const registry = new InvocationRegistry();
  const messageStore = new MessageStore();
  const db = new Database(':memory:');
  applyMigrations(db);
  const lifecycle = new ProfileMemoryLifecycleStore({ db, repository });
  const app = Fastify();
  registerCallbackAuthHook(app, registry);
  registerCallbackProposeProfileUpdateRoutes(app, {
    registry,
    proposalStore,
    messageStore,
    repository,
    socketManager: { emitToUser() {}, broadcastToRoom() {} },
  });
  registerCallbackReadProfileRoutes(app, { repository });
  registerCallbackMessageReadRoutes(app, { messageStore });
  const append = (content, catId = null) =>
    messageStore.append(
      canonicalTestMessageInput({
        userId: 'alice',
        catId,
        content,
        mentions: [],
        timestamp: Date.now(),
        threadId: 'thread-origin',
      }),
    );
  const proposedName = append('以后叫你「晨灯」，你当咱家的夜读搭子，好吗？');
  const acceptedName = append('好，我接住「晨灯」和夜读搭子。', 'codex-sol');
  const registration = append('把刚刚定好的称呼与角色留下，来历记提议和回应两条。');
  const context = async (catId = 'codex-sol', userId = 'alice', ownerAuthenticated = true) => {
    if (!ownerAuthenticated) return '';
    const response = await app.inject({
      method: 'GET',
      url: '/api/callbacks/profile',
      headers: await credential(userId, catId),
    });
    return response.statusCode === 200 ? response.json().content : '';
  };
  async function credential(userId = 'alice', catId = 'codex-sol', origin = registration.id) {
    const auth = await registry.create(userId, catId, 'thread-origin', undefined, origin);
    return { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken };
  }
  async function propose(content, origin = registration.id) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/propose-profile-update',
      headers: await credential('alice', 'codex-sol', origin),
      payload: {
        afterContent: content,
        rationale: '保留当前约定及可核查来历',
        signalKind: 'cvo-instructed',
        sourceMessageId: origin,
      },
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json().proposalId;
  }
  try {
    const content = [
      '当前约定：主体 codex-sol，称呼「晨灯」，角色「夜读搭子」。',
      `原事件提议：thread-origin#${proposedName.id}；回应：thread-origin#${acceptedName.id}。`,
      `登记来源：thread-origin#${registration.id}，不是起源。未证明全史首次。`,
      'codex 与 codex-sol 共享 persona，但角色主体仍是 codex-sol。',
    ].join('\n');
    const id = await propose(content);
    assert.doesNotMatch(await context(), /晨灯|夜读搭子/, 'pending proposal is not current memory');
    const approved = await approveProfileUpdate(id, 'alice', {
      store: proposalStore,
      lock: new SessionMutex(),
      repository,
    });
    assert.equal(approved.ok, true);
    // A fresh repository reconstructs from canonical durable files, not proposal-store memory.
    const restarted = new FileProfileRepository({ dataDir, relationshipKeyForCat: (cat) => mapping[cat] });
    const projected = restarted.readPrimer(restarted.scope('alice', 'codex-sol')).content;
    assert.match(projected, /晨灯/);
    assert.match(projected, /夜读搭子/);
    assert.match(projected, new RegExp(proposedName.id));
    assert.match(projected, new RegExp(acceptedName.id));
    for (const [message, from] of [
      [proposedName, { kind: 'user', userId: 'alice' }],
      [acceptedName, { kind: 'agent', catId: 'codex-sol' }],
    ]) {
      const source = await app.inject({
        method: 'GET',
        url: `/api/callbacks/get-message?messageId=${message.id}&mode=full`,
        headers: await credential(),
      });
      assert.equal(source.statusCode, 200, source.body);
      const original = source.json().message;
      assert.equal(original.content, message.content);
      assert.equal(original.userId, 'alice');
      assert.deepEqual(original.from, from);
    }
    const foreign = await app.inject({
      method: 'GET',
      url: `/api/callbacks/get-message?messageId=${proposedName.id}&mode=full`,
      headers: await credential('bob'),
    });
    assert.equal(foreign.statusCode, 404);
    assert.doesNotMatch(await context('opus'), /晨灯|夜读搭子/);
    assert.doesNotMatch(await context('codex-sol', 'bob'), /晨灯|夜读搭子/);
    assert.doesNotMatch(await context('codex-sol', 'alice', false), /晨灯|夜读搭子/);
    const correction = append('改叫「晴窗」，夜读搭子取消，以当前约定为准。');
    const correctedId = await propose(
      '当前约定：主体 codex-sol，称呼「晴窗」。历史称呼「晨灯」已停用；夜读搭子已取消。',
      correction.id,
    );
    const corrected = await approveProfileUpdate(correctedId, 'alice', {
      store: proposalStore,
      lock: new SessionMutex(),
      repository,
    });
    assert.equal(corrected.ok, true);
    assert.notEqual(corrected.revision, approved.revision);
    const stale = await app.inject({
      method: 'GET',
      url: `/api/callbacks/profile?expectedRevision=${encodeURIComponent(approved.revision)}`,
      headers: await credential(),
    });
    assert.equal(stale.statusCode, 409);
    assert.doesNotMatch(stale.body, /晨灯|晴窗/);
    assert.match(await context(), /已取消/);
    const forgotten = lifecycle.hardForget({
      ownerUserId: 'alice',
      memoryId: 'primer:maine-coon',
      command: {
        action: 'hard_forget',
        requestId: 'forget-relationship',
        expectedRevision: corrected.revision,
        confirmed: true,
      },
    });
    assert.equal(forgotten.outcome, 'forgotten');
    assert.doesNotMatch(await context(), /晨灯|晴窗|夜读搭子/);
    const forgottenHandle = await app.inject({
      method: 'GET',
      url: `/api/callbacks/profile?expectedRevision=${encodeURIComponent(corrected.revision)}`,
      headers: await credential(),
    });
    assert.equal(forgottenHandle.statusCode, 404);
    assert.equal(
      (await messageStore.getById(proposedName.id)) !== null,
      true,
      'forget does not rewrite original messages',
    );
    delete mapping['codex-sol'];
    const revoked = await app.inject({ method: 'GET', url: '/api/callbacks/profile', headers: await credential() });
    assert.equal(revoked.statusCode, 404);
    assert.doesNotMatch(await context(), /晨灯|晴窗|夜读搭子/);
  } finally {
    await app.close();
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
