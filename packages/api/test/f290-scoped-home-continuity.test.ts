import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { createCatId, type SessionRecord } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { AgentRegistry } from '../src/domains/cats/services/agents/registry/AgentRegistry.js';
import { backfillBoundSessionHistory } from '../src/domains/cats/services/session/BoundSessionHistoryImporter.js';
import { buildSessionBootstrap } from '../src/domains/cats/services/session/SessionBootstrap.js';
import { SessionSealer } from '../src/domains/cats/services/session/SessionSealer.js';
import { getHomeSessionPosition } from '../src/domains/cats/services/session/session-scope.js';
import { TranscriptReader } from '../src/domains/cats/services/session/TranscriptReader.js';
import { TranscriptWriter } from '../src/domains/cats/services/session/TranscriptWriter.js';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { SessionChainStore } from '../src/domains/cats/services/stores/ports/SessionChainStore.js';
import { ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.js';
import { DailyContextReflectionProducer } from '../src/domains/memory/DailyContextReflectionProducer.js';
import { listNativeSessionTargets } from '../src/routes/native-session-target.js';
import { createSessionCompactionSurface } from '../src/routes/session-compaction-surface.js';

const base = { userId: 'owner', catId: createCatId('codex-sol'), threadId: 'shared-channel' };
const scopes: NonNullable<SessionRecord['scopedInvocation']>[] = [
  { invocationId: 'public-child', executionScope: 'collective-participation', originMessageId: 'public-source' },
  {
    invocationId: 'private-child',
    executionScope: 'collective-work',
    originMessageId: 'private-source',
    taskId: 'task',
    executionRef: 'execution',
    executionRevision: 1,
    authorityRef: 'authority',
  },
];
const canaries = ['PUBLIC_TRANSCRIPT_CANARY', 'PRIVATE_TRANSCRIPT_CANARY'];

async function fixture(t: TestContext, withHome = true, scopeRecords = scopes) {
  const directory = await mkdtemp(join(tmpdir(), 'f290-home-boundary-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new SessionChainStore();
  const writer = new TranscriptWriter({ dataDir: directory });
  const reader = new TranscriptReader({ dataDir: directory });
  const sealer = new SessionSealer(store, writer);
  async function seal(record: SessionRecord, body: string, reason = 'test') {
    await writer.appendDurableEvent(
      { sessionId: record.id, ...base, seq: record.seq },
      { type: 'text', content: body },
      record.scopedInvocation?.invocationId ?? 'home-child',
    );
    await sealer.requestSeal({ sessionId: record.id, reason });
    assert.deepEqual(await sealer.finalize({ sessionId: record.id }), { sealed: true, clean: true });
  }
  const home = withHome ? store.create({ ...base, cliSessionId: 'HOME_NATIVE' }) : undefined;
  if (home) await seal(home, 'HOME_CONTINUITY_CANARY');
  const records = [];
  for (const [index, scope] of scopeRecords.entries()) {
    const record = store.create({ ...base, scopedInvocation: scope });
    store.bindCliSessionIdIfUnbound(record.id, `SCOPED_NATIVE_${index}`);
    await seal(record, canaries[index]!);
    records.push(record);
  }
  const active = store.create({ ...base, cliSessionId: 'HOME_NEXT_NATIVE' });
  return { store, reader, writer, home, records, active, seal };
}

test('owner history retains public/private archives while home bootstrap selects only home continuity', async (t) => {
  const f = await fixture(t);
  assert.equal(f.store.getChain(base.catId, base.threadId, base.userId).length, 4);
  for (const [index, record] of f.records.entries()) {
    const events = await f.reader.readAllEvents(record.id, base.threadId, base.catId);
    assert.match(JSON.stringify(events), new RegExp(canaries[index]!));
  }
  const selected: string[] = [];
  const reader = new Proxy(f.reader, {
    get(target, property) {
      if (property === 'readDigest')
        return (...args: Parameters<TranscriptReader['readDigest']>) => {
          selected.push(args[0]);
          return target.readDigest(...args);
        };
      return Reflect.get(target, property);
    },
  });
  const bootstrap = await buildSessionBootstrap(
    { sessionChainStore: f.store, transcriptReader: reader, ownerUserId: base.userId },
    base.catId,
    base.threadId,
  );
  assert.ok(bootstrap);
  assert.deepEqual(selected, [f.home!.id]);
  assert.match(bootstrap.text, /Session Continuity — Session #2\]/);
  assert.match(bootstrap.text, /This is session #2 of 2 total sessions/);
  assert.doesNotMatch(bootstrap.text, /trace session/);
  assert.equal(bootstrap.sessionSeq, f.active.seq, 'persistent raw identity stays unchanged');
});

for (const scope of scopes) {
  test(`a home after one ${scope.executionScope} trace is home session 2 of 2`, async (t) => {
    const f = await fixture(t, true, [scope]);
    assert.deepEqual(
      f.store.getChain(base.catId, base.threadId, base.userId).map((record) => record.seq),
      [0, 1, 2],
    );
    const bootstrap = await buildSessionBootstrap(
      { sessionChainStore: f.store, transcriptReader: f.reader, ownerUserId: base.userId },
      base.catId,
      base.threadId,
    );
    assert.ok(bootstrap);
    assert.match(bootstrap.text, /Session Continuity — Session #2\]/);
    assert.match(bootstrap.text, /This is session #2 of 2 total sessions/);
    assert.doesNotMatch(bootstrap.text, /trace session/);
    assert.equal(bootstrap.sessionSeq, 2, 'raw trace-chain identity is not the displayed home ordinal');
  });
}

test('a pending home continuation and its handoff use home ordinals despite interleaved traces', async (t) => {
  const f = await fixture(t);
  f.store.update(f.active.id, {
    catHandoffNote: {
      proposalId: 'home-handoff',
      sourceSessionId: f.active.id,
      done: 'ordinary home work',
      nextSteps: 'continue home work',
      persistedAt: Date.now(),
    },
  });
  await f.seal(f.active, 'HOME_SECOND_CANARY', 'cat_initiated_handoff');
  assert.equal(f.store.getActive(base.catId, base.threadId, base.userId), null);
  const bootstrap = await buildSessionBootstrap(
    { sessionChainStore: f.store, transcriptReader: f.reader, ownerUserId: base.userId },
    base.catId,
    base.threadId,
  );
  assert.ok(bootstrap);
  assert.match(bootstrap.text, /This is session #3 of 3 total sessions/);
  assert.match(bootstrap.text, /Cat Handoff Note[^\n]*session #2\]/);
  assert.doesNotMatch(bootstrap.text, /trace session/);
  assert.equal(bootstrap.sessionSeq, 4, 'the next raw trace identity still includes scoped records');
});

test('a home invocation with only scoped sealed history receives no bootstrap', async (t) => {
  const f = await fixture(t, false);
  const result = await buildSessionBootstrap(
    { sessionChainStore: f.store, transcriptReader: f.reader, ownerUserId: base.userId },
    base.catId,
    base.threadId,
  );
  assert.equal(result, null);
});

for (const { scope, memoryFromStart } of scopes.flatMap((scope) => [
  { scope, memoryFromStart: true },
  { scope, memoryFromStart: false },
])) {
  test(`actual Thread Memory after ${scope.executionScope}, ${memoryFromStart ? 'full' : 'late-start'} memory uses home numbering`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'f290-memory-position-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const threads = new ThreadStore();
    const origin = { ...base, threadId: threads.create(base.userId).id };
    const store = new SessionChainStore();
    const writer = new TranscriptWriter({ dataDir: directory });
    const reader = new TranscriptReader({ dataDir: directory });
    let sealer = new SessionSealer(store, writer, memoryFromStart ? threads : undefined, reader);
    const seal = async (record: SessionRecord, content: string) => {
      await writer.appendDurableEvent(
        { sessionId: record.id, ...origin, seq: record.seq },
        { type: 'text', content },
        record.scopedInvocation?.invocationId ?? 'home-child',
      );
      await sealer.requestSeal({ sessionId: record.id, reason: 'test' });
      assert.deepEqual(await sealer.finalize({ sessionId: record.id }), { sealed: true, clean: true });
    };
    const first = store.create({ ...origin, cliSessionId: 'HOME_1' });
    await seal(first, 'HOME_FIRST');
    const firstMemory = threads.getThreadMemory(origin.threadId);
    const scoped = store.create({ ...origin, scopedInvocation: scope });
    await seal(scoped, 'SCOPED_MEMORY_CANARY');
    assert.deepEqual(threads.getThreadMemory(origin.threadId), firstMemory, 'scoped seal cannot update home memory');
    sealer = new SessionSealer(store, writer, threads, reader);
    const second = store.create({ ...origin, cliSessionId: 'HOME_2' });
    await seal(second, 'HOME_SECOND');
    const memory = threads.getThreadMemory(origin.threadId);
    assert.ok(memory);
    assert.equal(memory.sessionsIncorporated, memoryFromStart ? 2 : 1);
    assert.match(memory.summary, /^Session #2 /);
    if (memoryFromStart) assert.match(memory.summary, /\nSession #1 /);
    else assert.doesNotMatch(memory.summary, /Session #1 /);
    assert.doesNotMatch(memory.summary, /Session #3|SCOPED_MEMORY_CANARY/);
    const third = store.create({ ...origin, cliSessionId: 'HOME_3' });
    assert.deepEqual([first.seq, scoped.seq, second.seq, third.seq], [0, 1, 2, 3]);
    assert.equal((await reader.readDigest(second.id, origin.threadId, origin.catId))?.seq, 2);
    const bootstrap = await buildSessionBootstrap(
      { sessionChainStore: store, transcriptReader: reader, threadStore: threads, ownerUserId: origin.userId },
      origin.catId,
      origin.threadId,
    );
    assert.ok(bootstrap);
    assert.match(bootstrap.text, /This is session #3 of 3 total sessions/);
    assert.ok(bootstrap.text.includes(`[Thread Memory — ${memory.sessionsIncorporated} sessions]\n${memory.summary}`));
    assert.doesNotMatch(bootstrap.text, /trace session|SCOPED_MEMORY_CANARY/);
  });
}

test('the shared home position refuses scoped or missing identities and preserves the next home ordinal', async (t) => {
  const f = await fixture(t);
  const chain = f.store.getChain(base.catId, base.threadId, base.userId);
  assert.deepEqual(getHomeSessionPosition(chain, f.active.id), { ordinal: 2, count: 2 });
  assert.deepEqual(getHomeSessionPosition(chain), { ordinal: 3, count: 3 });
  for (const id of [f.records[0]!.id, f.records[1]!.id, 'missing']) {
    assert.throws(() => getHomeSessionPosition(chain, id), /home_session_position_unavailable/);
  }
});

test('public/private transcript canaries cannot be backfilled into ordinary Thread messages', async (t) => {
  const f = await fixture(t);
  const messages = new MessageStore();
  const result = await backfillBoundSessionHistory({
    sessionChainStore: f.store,
    transcriptReader: f.reader,
    messageStore: messages,
    ...base,
  });
  assert.equal(result.status, 'ok');
  const content = JSON.stringify(messages.getByThread(base.threadId));
  assert.match(content, /HOME_CONTINUITY_CANARY/);
  assert.doesNotMatch(content, /PUBLIC_TRANSCRIPT_CANARY|PRIVATE_TRANSCRIPT_CANARY/);
});

test('daily reflection sees home session sources but neither public nor private scoped sources', async (t) => {
  const f = await fixture(t);
  const reflected: string[] = [];
  const producer = new DailyContextReflectionProducer({
    ownerUserId: base.userId,
    threadStore: { list: () => [{ id: base.threadId }] } as never,
    sessionChainStore: f.store,
    getHouseholdTimeZone: () => 'UTC',
    now: () => Date.now() + 86_400_000,
    reflectionProducer: {
      async reflectSessions(sources) {
        reflected.push(...sources.map((source) => source.sessionId));
        return {
          householdLocalDate: 'test',
          extracted: 0,
          accepted: 0,
          duplicates: 0,
          rejected: 0,
          cuesDelivered: 0,
          outputs: [],
        };
      },
    },
  });
  await producer.run();
  assert.deepEqual(reflected.sort(), [f.home!.id, f.active.id].sort());
});

test('latest-digest accepts only home identities and excludes newer public/private sealed nodes', async (t) => {
  const f = await fixture(t);
  const app = Fastify();
  t.after(() => app.close());
  createSessionCompactionSurface({ sessionChainStore: f.store, transcriptReader: f.reader }).registerLatestDigestRoute(
    app,
  );
  const home = await app.inject({ url: '/api/sessions/latest-digest?cliSessionId=HOME_NEXT_NATIVE' });
  assert.equal(home.statusCode, 200, home.body);
  assert.equal(home.json().sessionId, f.home!.id);
  for (const index of [0, 1]) {
    const scoped = await app.inject({ url: `/api/sessions/latest-digest?cliSessionId=SCOPED_NATIVE_${index}` });
    assert.equal(scoped.statusCode, 404, 'scoped native identity cannot consume the home continuity surface');
  }
});

test('native goal/review write targets cannot select active scoped identities, with or without home', async () => {
  const store = new SessionChainStore();
  const registry = new AgentRegistry();
  registry.register(base.catId, {
    async *invoke() {},
    async requestNativeGoal() {
      throw new Error('must not execute');
    },
    async requestNativeReview() {
      throw new Error('must not execute');
    },
  });
  for (const [index, scope] of scopes.entries()) {
    const scoped = store.create({ ...base, scopedInvocation: scope });
    store.bindCliSessionIdIfUnbound(scoped.id, `SCOPED_NATIVE_${index}`);
  }
  for (const capability of ['requestNativeGoal', 'requestNativeReview'] as const) {
    const input = { agentRegistry: registry, sessionChainStore: store, ...base, capability };
    assert.deepEqual(await listNativeSessionTargets(input), []);
    const home = store.getOrCreateActive({ ...base });
    const homeNative = `HOME_NATIVE_${capability}`;
    store.bindCliSessionIdIfUnbound(home.id, homeNative);
    assert.deepEqual(
      (await listNativeSessionTargets(input)).map((target) => target.sessionId),
      [homeNative],
    );
    store.update(home.id, { status: 'sealed' });
  }
});
