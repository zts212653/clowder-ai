import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationTracker } from '../dist/domains/cats/services/agents/invocation/InvocationTracker.js';
import { QueueProcessor } from '../dist/domains/cats/services/agents/invocation/QueueProcessor.js';
import { InvocationRecordStore } from '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js';
import { queueHttpFixture } from './helpers/1398-queue-http-fixture.js';
import { crossThreadFailureStores } from './helpers/cross-thread-failure-fixture.mjs';
import { waitFor } from './helpers/issue1862-dispatch-fixture.js';
import { redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

for (const kind of ['memory', 'redis']) {
  for (const reason of ['invalid_explicit_target', 'execution_binding_conflict']) {
    test(
      `${kind}: an undeliverable cross-thread return retires with diagnosis and never resurrects (${reason})`,
      {
        skip: kind === 'redis' ? redisIsolationSkipReason(process.env.REDIS_URL) : false,
      },
      async (t) => {
        const stores = await crossThreadFailureStores(t, kind);
        const f = await queueHttpFixture(t, { messageStore: stores.messages, ledgerStore: stores.ledger });
        const origin = await f.threads.create('owner', 'actual caller');
        const sent = await f.queue.send(
          f.messages,
          {
            from: { kind: 'agent', catId: 'codex' },
            userId: 'owner',
            threadId: f.thread.id,
            content: '@gemini work',
            mentions: ['gemini'],
            timestamp: 100,
            extra: { crossPost: { sourceThreadId: origin.id } },
          },
          {
            from: { kind: 'agent', catId: 'codex' },
            userId: 'owner',
            threadId: f.thread.id,
            kind: 'message_wake',
            sourceCategory: 'a2a',
            content: '@gemini work',
            targetCats: ['gemini'],
            ownerAuthProvenance: 'strict',
            intent: 'execute',
            autoExecute: true,
          },
        );
        const claim = await f.queue.claimPreAdmissionFailureAcrossUsersDurable(f.thread.id, sent.entry.id, ['gemini']);
        const failure = await f.queue.terminalizeClaimedAdmissionFailure(
          f.messages,
          sent.message,
          claim,
          'gemini',
          'invalid_explicit_target',
        );
        const [wake] = await f.queue.listAllDurable(origin.id);
        assert.ok(wake);
        const caller = f.agents.get('codex');
        let launches = 0;
        caller.invoke = async function* () {
          launches++;
          throw new Error('undeliverable caller must not launch');
        };
        const originalSnapshot = caller.implementationSnapshot;
        if (reason === 'invalid_explicit_target')
          f.agents.markUnavailable('codex', { code: 'rejected-account-binding', message: 'caller unavailable' });
        else
          caller.implementationSnapshot = () => ({
            key: 'fixture:wrong-caller',
            generation: 'fixture',
            clientId: 'kimi',
          });
        f.router.refreshFromRegistry(f.agents);
        const diagnostics = [];
        const records = new InvocationRecordStore();
        const tracker = new InvocationTracker();
        const processor = new QueueProcessor({
          queue: f.queue,
          messageStore: f.messages,
          threadStore: f.threads,
          router: f.router,
          invocationTracker: tracker,
          invocationRecordStore: records,
          socketManager: { emitToUser() {}, broadcastAgentMessage() {}, broadcastToRoom() {} },
          log: { info() {}, warn: (entry) => diagnostics.push(entry), error: (entry) => diagnostics.push(entry) },
        });
        await processor.requestDrain(origin.id);
        await waitFor(async () => (await f.queue.getDurableEntry(origin.id, wake.id)) === null);
        await waitFor(() => !tracker.has(origin.id, 'codex'));
        assert.equal(launches, 0);
        assert.ok(
          diagnostics.some(
            (entry) =>
              entry.event === 'private_input_pre_admission_failed' &&
              entry.entryId === wake.id &&
              entry.threadId === origin.id &&
              entry.reason === reason,
          ),
          'structured diagnosis is queryable by exact origin and entry',
        );
        if (reason === 'execution_binding_conflict') {
          const record = records.listLatestTerminalByThreadIds([origin.id], 'owner').get(origin.id);
          assert.equal(record.error, `a2a_failure_undeliverable:${wake.payload.sourceRecordId}:${reason}`);
        }
        assert.deepEqual(
          await f.messages.getByThread(origin.id),
          [],
          'this boundary intentionally publishes no origin History result',
        );
        assert.ok(
          await f.messages.getById(failure.failureMessage.id),
          'the canonical failure stays in its destination thread',
        );
        if (reason === 'invalid_explicit_target') f.agents.register('codex', caller);
        else caller.implementationSnapshot = originalSnapshot;
        f.router.refreshFromRegistry(f.agents);
        await f.queue.reprojectFailureWakes(failure.inputMessage, ['gemini']);
        const restarted = new InvocationQueue(stores.ledger);
        await restarted.hydrateFromLedger(f.messages);
        assert.deepEqual(await restarted.listAllDurable(origin.id), [], 'retired control cannot resurrect on recovery');
        await processor.requestDrain(origin.id);
        assert.equal(launches, 0, 'restoring the caller does not revive a retired notice');
      },
    );
  }
}
