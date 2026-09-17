import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { A2ADispatchDispositionService } from '../dist/domains/ball-custody/A2ADispatchDispositionService.js';
import { BallCustodyProjector } from '../dist/domains/ball-custody/BallCustodyProjector.js';
import { CoordinationTerminalRetirement } from '../dist/domains/ball-custody/CoordinationTerminalRetirement.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { RedisMessageStore } from '../dist/domains/cats/services/stores/redis/RedisMessageStore.js';
import { runTerminalQueueHarness } from './helpers/issue1371-terminal-queue-harness.js';

const log = () => ({ info: mock.fn(), warn: mock.fn() });

test('#1371: crash after message commit reconstructs exact retirement without provider replay', async () => {
  const { h, terminal, deps, queue } = await runTerminalQueueHarness('retirement unavailable');
  assert.equal(queue.list(terminal.threadId, terminal.userId).length, 0);
  assert.deepEqual(h.messageStore.getById(terminal.id).queueCustody.handledByCatIds, ['fable5']);
  assert.equal(h.eventLog.events.filter((event) => event.kind === 'ball.dispatch_dispositioned').length, 0);
  // Discard process-local recovery state. Reopen serialized message facts, the
  // existing event log and its projector; the old invocation is no longer latest.
  const records = new Map(structuredClone(h.messageStore.getRecent(100)).map((message) => [message.id, message]));
  const store = {
    getById: async (id) => structuredClone(records.get(id) ?? null),
    scanCoordinationTerminalMessageIds: async () => ({
      messageIds: [...records.values()]
        .filter((message) => message.extra?.coordination?.phase === 'terminal')
        .map((message) => message.id),
    }),
  };
  const projector = new BallCustodyProjector(h.eventLog, h.projectionStore);
  const service = new A2ADispatchDispositionService({
    registry: { isLatest: async () => false },
    messageStore: store,
    ballCustodyEventLog: h.eventLog,
    ballCustodyProjectionStore: h.projectionStore,
    ballCustody: h.ingest,
    repairProjection: (key) => projector.rebuild(key),
  });
  const recovery = new CoordinationTerminalRetirement({ messageStore: store, service, log: log() });
  assert.deepEqual(await recovery.runPage(), { inspected: 1, applied: 1, failed: 0 });
  assert.deepEqual(await recovery.runPage(), { inspected: 1, applied: 0, failed: 0 });
  assert.equal(h.eventLog.events.filter((event) => event.kind === 'ball.dispatch_dispositioned').length, 1);
  assert.equal(deps.router.routeExecution.mock.calls.length, 1, 'recovery must never run the source body again');
  assert.deepEqual(records.get(terminal.id).queueCustody, h.messageStore.getById(terminal.id).queueCustody);
});

test('#1371: one failing source does not starve later pages and is retried on the next pass', async () => {
  const { h, terminal } = await runTerminalQueueHarness();
  let fail = true;
  const seenCursors = [];
  const store = {
    getById: (id) => h.messageStore.getById(id),
    scanCoordinationTerminalMessageIds: async (cursor) => {
      seenCursors.push(cursor);
      return cursor
        ? { messageIds: [terminal.id] }
        : {
            messageIds: [terminal.id],
            nextCursor: { offset: 100, upperBound: 200 },
          };
    },
  };
  const service = {
    completeFromCoordinationTerminal: async () => {
      if (fail) throw new Error('unavailable');
      return { outcome: 'replayed' };
    },
  };
  const recovery = new CoordinationTerminalRetirement({ messageStore: store, service, log: log() });
  assert.equal((await recovery.runPage()).failed, 1);
  fail = false;
  assert.equal((await recovery.runPage()).failed, 0);
  assert.equal((await recovery.runPage()).failed, 0);
  assert.deepEqual(seenCursors, [undefined, { offset: 100, upperBound: 200 }, undefined]);
});

test('#1371: concurrent ticks share a page and a scan failure retains its cursor', async () => {
  let release;
  let fail = true;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const scan = mock.fn(async () => {
    await gate;
    if (fail) throw new Error('read outage');
    return { messageIds: [] };
  });
  const recovery = new CoordinationTerminalRetirement({
    messageStore: {
      getById: async () => null,
      scanCoordinationTerminalMessageIds: scan,
    },
    service: {},
    log: log(),
  });
  const first = recovery.runPage();
  const second = recovery.runPage();
  assert.equal(first, second);
  release();
  await assert.rejects(first, /read outage/);
  fail = false;
  assert.deepEqual(await recovery.runPage(), { inspected: 0, applied: 0, failed: 0 });
  assert.deepEqual(
    scan.mock.calls.map((call) => call.arguments),
    [[undefined], [undefined]],
  );
});

test('#1371: memory scan reads bounded pages and freezes the current pass boundary', () => {
  const store = new MessageStore();
  const append = (index) =>
    store.append({
      userId: 'u',
      threadId: 't',
      catId: 'opus',
      mentions: [],
      content: 'terminal',
      timestamp: index + 1,
      extra: { coordination: { id: `c-${index}`, phase: 'terminal', hop: 2 } },
    });
  for (let i = 0; i < 205; i++) append(i);
  const first = store.scanCoordinationTerminalMessageIds();
  assert.equal(first.messageIds.length, 100);
  for (let i = 205; i < 215; i++) append(i);
  const second = store.scanCoordinationTerminalMessageIds(first.nextCursor);
  const third = store.scanCoordinationTerminalMessageIds(second.nextCursor);
  assert.equal(second.messageIds.length, 100);
  assert.equal(third.messageIds.length, 5);
  assert.equal(third.nextCursor, undefined);
  assert.equal(new Set([...first.messageIds, ...second.messageIds, ...third.messageIds]).size, 205);
  assert.equal(store.scanCoordinationTerminalMessageIds().nextCursor.upperBound, 215);
});

test('#1371: Redis page bounds hydration and uses its raw timeline, including queued sources', async () => {
  const ranges = [];
  const requested = [];
  const ids = Array.from({ length: 205 }, (_, i) => `message-${i}`);
  const redis = {
    options: { keyPrefix: 'isolated:' },
    zcard: async () => ids.length,
    zrange: async (key, start, end) => {
      ranges.push([key, start, end]);
      return ids.slice(start, end + 1);
    },
    pipeline: () => {
      const batch = [];
      return {
        hget: (key, field) => {
          requested.push([key, field]);
          batch.push(key);
        },
        exec: async () =>
          batch.map((key) => [
            null,
            JSON.stringify({
              coordination: {
                id: key,
                phase: key.endsWith('-0') ? 'active' : 'terminal',
                hop: 2,
              },
            }),
          ]),
      };
    },
  };
  const store = new RedisMessageStore(redis);
  const first = await store.scanCoordinationTerminalMessageIds();
  assert.equal(first.messageIds.length, 99);
  assert.equal(requested.length, 100);
  assert.deepEqual(ranges, [['msg:timeline', 0, 99]]);
  const second = await store.scanCoordinationTerminalMessageIds(first.nextCursor);
  const third = await store.scanCoordinationTerminalMessageIds(second.nextCursor);
  assert.equal(third.messageIds.length, 5);
  assert.equal(third.nextCursor, undefined);
  assert.equal(requested.length, 205);
  assert.equal(
    requested.every(([key, field]) => key.startsWith('msg:message-') && field === 'extra'),
    true,
  );
});
