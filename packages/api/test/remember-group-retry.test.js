import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createRedisClient } from '@cat-cafe/shared/utils';
import Fastify from 'fastify';
import { ApprovalIngress } from '../dist/domains/approval-hub/ApprovalIngress.js';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { FileProfileRepository } from '../dist/domains/cats/services/profile/ProfileRepository.js';
import { InMemoryProfileUpdateProposalStore } from '../dist/domains/cats/services/stores/ports/ProfileUpdateProposalStore.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { RedisMessageStore } from '../dist/domains/cats/services/stores/redis/RedisMessageStore.js';
import { callbacksRoutes } from '../dist/routes/callbacks.js';
import { assertRedisIsolationOrThrow, cleanupClientKeyspace } from './helpers/redis-test-helpers.js';

test('correcting a rejected item with the same request key refreshes the persisted group and socket payload', async (t) => {
  assertRedisIsolationOrThrow(process.env.REDIS_URL, 'remember group corrected retry');
  const redis = createRedisClient({ url: process.env.REDIS_URL, keyPrefix: `remember-retry:${randomUUID()}:` });
  const directory = mkdtempSync(join(tmpdir(), 'remember-retry-'));
  const app = Fastify(),
    registry = new InvocationRegistry(),
    messages = new RedisMessageStore(redis);
  const threads = new ThreadStore(),
    thread = threads.create('owner', 'Remember retry');
  const broadcasts = [],
    snapshots = [];
  const sockets = {
    broadcastToRoom: (...args) => broadcasts.push(structuredClone(args)),
    emitToUser: (...args) => snapshots.push(structuredClone(args)),
  };
  t.after(async () => {
    await app.close();
    await cleanupClientKeyspace(redis);
    await redis.quit();
    rmSync(directory, { recursive: true, force: true });
  });
  const source = await messages.append({
    from: { kind: 'user', userId: 'owner' },
    userId: 'owner',
    threadId: thread.id,
    content: '请保留工作中的具体背景。',
    mentions: [],
    timestamp: Date.now(),
  });
  const auth = await registry.create('owner', 'codex-astra', thread.id, undefined, undefined, undefined, source.id);
  await app.register(callbacksRoutes, {
    registry,
    messageStore: messages,
    socketManager: sockets,
    threadStore: threads,
    evidenceStore: {
      async store() {},
      async search() {
        return [];
      },
    },
    markerQueue: { enqueue() {} },
    reflectionService: { async run() {} },
    profileUpdateProposalStore: new InMemoryProfileUpdateProposalStore(),
    profileRepository: new FileProfileRepository({ dataDir: directory, relationshipKeyForCat: () => 'maine-coon' }),
    approvalIngress: new ApprovalIngress({ messageStore: messages, socketManager: sockets }),
  });
  const good = {
    afterContent: '先交代具体背景。',
    rationale: '主人明确表达',
    signalKind: 'cvo-instructed',
    targetLayer: 'capsule',
  };
  const submit = (second) =>
    app.inject({
      method: 'POST',
      url: '/api/callbacks/remember',
      headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
      payload: {
        clientRequestId: 'same-request',
        items: [
          { itemId: 'a', target: 'profile', payload: good },
          { itemId: 'b', target: 'profile', payload: second },
        ],
      },
    });
  const firstResponse = await submit({ rationale: '缺少正文', signalKind: 'cvo-instructed', targetLayer: 'capsule' });
  assert.equal(firstResponse.statusCode, 200, firstResponse.body);
  const first = firstResponse.json();
  assert.deepEqual(
    first.results.map((row) => row.statusCode),
    [200, 400],
  );
  const original = await messages.getById(first.messageId);
  assert.deepEqual(
    original.extra.rich.blocks[0].meta.memoryGroup.rows.map((row) => row.statusCode),
    [200, 400],
  );
  const secondResponse = await submit({ ...good, afterContent: '设计稿要看得出具体背景。' });
  assert.equal(secondResponse.statusCode, 200, secondResponse.body);
  const second = secondResponse.json();
  assert.equal(second.groupId, first.groupId);
  assert.equal(second.messageId, first.messageId);
  assert.deepEqual(
    second.results.map((row) => row.statusCode),
    [200, 200],
  );
  assert.equal(second.results[0].result.proposalId, first.results[0].result.proposalId);
  const stored = await new RedisMessageStore(redis).getById(second.messageId);
  const rows = stored.extra.rich.blocks[0].meta.memoryGroup.rows;
  assert.deepEqual(
    rows.map((row) => row.statusCode),
    [200, 200],
    'Fresh Redis read must include the corrected item',
  );
  assert.equal(rows[1].proposalId, second.results[1].result.proposalId);
  assert.equal(rows[1].error, undefined);
  const published = broadcasts.filter(
    ([, event, data]) => event === 'connector_message' && data.message?.id === second.messageId,
  );
  assert.deepEqual(published.at(-1)[2].message.extra.rich.blocks[0].meta.memoryGroup.rows, rows);
  const updated = snapshots.filter(
    ([, event, data]) => event === 'message_snapshot_updated' && data.message?.id === second.messageId,
  );
  assert.equal(updated.length, 1, 'The existing same-id update consumer must receive the corrected group');
  assert.deepEqual(updated[0][2].message.extra.rich.blocks[0].meta.memoryGroup.rows, rows);
});
