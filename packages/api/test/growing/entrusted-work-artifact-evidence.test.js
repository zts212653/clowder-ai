import '../helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { TaskStore } from '../../dist/domains/cats/services/stores/ports/TaskStore.js';
import { assertRedisIsolationOrThrow, redisIsolationSkipReason } from '../helpers/redis-test-helpers.js';

for (const mode of ['memory', 'redis'])
  describe(
    `Task artifact evidence CAS (${mode})`,
    { skip: mode === 'redis' && redisIsolationSkipReason(process.env.REDIS_URL) },
    () => {
      let redis,
        Store = TaskStore;
      before(async () => {
        if (mode !== 'redis') return;
        assertRedisIsolationOrThrow(process.env.REDIS_URL, 'artifact-evidence');
        const { createRedisClient } = await import('@cat-cafe/shared/utils');
        ({ RedisTaskStore: Store } = await import('../../dist/domains/cats/services/stores/redis/RedisTaskStore.js'));
        redis = createRedisClient({ url: process.env.REDIS_URL, keyPrefix: `artifact-evidence-${randomUUID()}:` });
      });
      after(async () => {
        await redis?.quit();
      });
      async function fixture() {
        const store = mode === 'redis' ? new Store(redis) : new Store();
        const { task } = await store.admitEntrustedWork({
          subjectKey: `entrusted:${randomUUID()}`,
          task: {
            userId: 'owner',
            threadId: 'thread',
            ownerCatId: 'codex',
            createdBy: 'user',
            title: 'Report',
            why: 'Report',
          },
          entrustedWork: {
            revision: 1,
            admission: {
              basis: 'authorized_source',
              sourceRefs: ['message:source'],
              authorityRef: 'message:admission',
              idempotencyKey: 'admission',
              receiptRef: 'receipt:admission',
              admittedAt: 1,
            },
            intendedOutcome: 'Report',
            time: {},
            artifactRefs: [],
            closure: { state: 'open', condition: 'accepted', expectedSignal: 'accepted', evidenceRefs: [] },
          },
        });
        // Store-boundary fixture only. Production caller must verify Registry + durable publication before using this port.
        const input = {
          expectedRevision: 1,
          executionAuthorityRevision: 1,
          ownerUserId: 'owner',
          ownerCatId: 'codex',
          threadId: 'thread',
          admissionRef: 'message:admission',
          artifactRef: '/uploads/task-proof.md',
        };
        return { store, task, input };
      }
      test('append only advances aggregate; exact retry after lost reply is unchanged and ordinary update still revokes', async () => {
        const { store, task, input } = await fixture();
        const result = await store.attachEntrustedWorkArtifactEvidence(task.id, input);
        assert.equal(result.kind, 'attached');
        assert.equal(result.task.entrustedWork.revision, 2);
        assert.equal(result.task.entrustedWork.executionAuthorityRevision, 1);
        assert.deepEqual(result.task.entrustedWork.artifactRefs, [input.artifactRef]);
        const before = structuredClone(result.task);
        assert.equal((await store.attachEntrustedWorkArtifactEvidence(task.id, input)).kind, 'already_attached');
        assert.deepEqual(await store.get(task.id), before);
        await store.updateEntrustedWork(task.id, { expectedRevision: 2, artifactRefs: ['/uploads/ordinary.md'] });
        assert.equal((await store.attachEntrustedWorkArtifactEvidence(task.id, input)).kind, 'authority_conflict');
      });
      for (const field of ['ownerUserId', 'ownerCatId', 'threadId', 'admissionRef', 'executionAuthorityRevision']) {
        test(`mismatched ${field} cannot append or authorize an exact retry`, async () => {
          const { store, task, input } = await fixture();
          const before = structuredClone(await store.get(task.id));
          const changed = { ...input, [field]: field === 'executionAuthorityRevision' ? 2 : 'other' };
          assert.equal((await store.attachEntrustedWorkArtifactEvidence(task.id, changed)).kind, 'authority_conflict');
          assert.deepEqual(await store.get(task.id), before);
        });
      }
      test('stale aggregate, close and unknown payload fields never mutate', async () => {
        const { store, task, input } = await fixture();
        assert.equal(
          (await store.attachEntrustedWorkArtifactEvidence(task.id, { ...input, expectedRevision: 2 })).kind,
          'revision_conflict',
        );
        await assert.rejects(async () =>
          store.attachEntrustedWorkArtifactEvidence(task.id, { ...input, status: 'doing' }),
        );
        const closed = await store.closeEntrustedWork(task.id, {
          expectedRevision: 1,
          closure: { ...task.entrustedWork.closure, state: 'satisfied', evidenceRefs: ['message:accepted'] },
        });
        const before = structuredClone(closed.task);
        assert.equal((await store.attachEntrustedWorkArtifactEvidence(task.id, input)).kind, 'already_closed');
        assert.deepEqual(await store.get(task.id), before);
      });
      test('two writers cannot append different refs using the same aggregate CAS', async () => {
        const { store, task, input } = await fixture();
        const second = mode === 'redis' ? new Store(redis) : store;
        const results = await Promise.all([
          store.attachEntrustedWorkArtifactEvidence(task.id, input),
          second.attachEntrustedWorkArtifactEvidence(task.id, { ...input, artifactRef: '/uploads/other.md' }),
        ]);
        assert.deepEqual(results.map((r) => r.kind).sort(), ['attached', 'revision_conflict']);
        const canonical = await second.get(task.id);
        assert.equal(canonical.entrustedWork.artifactRefs.length, 1);
        assert.equal(canonical.entrustedWork.executionAuthorityRevision, 1);
      });
      test('ordinary mutation wins against evidence without losing revocation', async () => {
        const { store, task, input } = await fixture();
        await store.updateEntrustedWork(task.id, { expectedRevision: 1, status: 'doing' });
        const before = structuredClone(await store.get(task.id));
        assert.equal((await store.attachEntrustedWorkArtifactEvidence(task.id, input)).kind, 'authority_conflict');
        assert.deepEqual(await store.get(task.id), before);
      });
      test('same-ref concurrent replay is idempotent, preserves existing evidence and has no TTL', async () => {
        const { store, task, input } = await fixture();
        const second = mode === 'redis' ? new Store(redis) : store;
        const results = await Promise.all([
          store.attachEntrustedWorkArtifactEvidence(task.id, input),
          second.attachEntrustedWorkArtifactEvidence(task.id, input),
        ]);
        assert.deepEqual(results.map((r) => r.kind).sort(), ['already_attached', 'attached']);
        const next = await second.attachEntrustedWorkArtifactEvidence(task.id, {
          ...input,
          expectedRevision: 2,
          artifactRef: '/uploads/second.md',
        });
        assert.deepEqual(next.task.entrustedWork.artifactRefs, [input.artifactRef, '/uploads/second.md']);
        assert.equal(next.task.entrustedWork.revision, 3);
        assert.equal(next.task.entrustedWork.executionAuthorityRevision, 1);
        if (redis) assert.equal(await redis.ttl(`task:${task.id}`), -1);
      });
      for (const kind of ['legacy', 'overflow', 'capacity'])
        test(`${kind} refuses without any partial change`, async () => {
          const { store, task, input } = await fixture();
          const work = structuredClone(task.entrustedWork);
          if (kind === 'legacy') delete work.executionAuthorityRevision;
          if (kind === 'overflow') work.revision = Number.MAX_SAFE_INTEGER;
          if (kind === 'capacity') work.artifactRefs = Array.from({ length: 64 }, (_, i) => `artifact:${i}`);
          if (redis) await redis.hset(`task:${task.id}`, 'entrustedWork', JSON.stringify(work));
          else task.entrustedWork = work;
          const before = structuredClone(await store.get(task.id));
          const call = () =>
            store.attachEntrustedWorkArtifactEvidence(task.id, { ...input, expectedRevision: work.revision });
          if (kind === 'legacy') assert.equal((await call()).kind, 'authority_conflict');
          else await assert.rejects(async () => call());
          assert.deepEqual(await store.get(task.id), before);
        });
      if (mode === 'redis') {
        test('authority transition inside the CAS window wins without resurrecting old evidence', async () => {
          const { store, task, input } = await fixture();
          const evalOriginal = redis.eval.bind(redis);
          let raced = false;
          redis.eval = async (...args) => {
            if (!raced && String(args[0]).includes('TASK_ATTACH_ARTIFACT_EVIDENCE')) {
              raced = true;
              await new Store(redis).updateEntrustedWork(task.id, { expectedRevision: 1, status: 'doing' });
            }
            return evalOriginal(...args);
          };
          try {
            assert.equal((await store.attachEntrustedWorkArtifactEvidence(task.id, input)).kind, 'authority_conflict');
            const live = await store.get(task.id);
            assert.equal(live.entrustedWork.executionAuthorityRevision, 2);
            assert.deepEqual(live.entrustedWork.artifactRefs, []);
          } finally {
            redis.eval = evalOriginal;
          }
        });
        test('successful CAS with lost response reconstructs exactly once in a fresh store', async () => {
          const { store, task, input } = await fixture();
          const evalOriginal = redis.eval.bind(redis);
          redis.eval = async (...args) => {
            const value = await evalOriginal(...args);
            if (String(args[0]).includes('TASK_ATTACH_ARTIFACT_EVIDENCE') && value === 1)
              throw Error('simulated response loss');
            return value;
          };
          try {
            await assert.rejects(() => store.attachEntrustedWorkArtifactEvidence(task.id, input), /response loss/);
          } finally {
            redis.eval = evalOriginal;
          }
          const restored = new Store(redis),
            before = await restored.get(task.id);
          assert.equal((await restored.attachEntrustedWorkArtifactEvidence(task.id, input)).kind, 'already_attached');
          assert.deepEqual(await restored.get(task.id), before);
          assert.equal(before.entrustedWork.revision, 2);
        });
      }
    },
  );
