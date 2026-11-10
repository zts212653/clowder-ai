import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MessageSearchService } from '../../dist/domains/memory/MessageSearchService.js';

function fixture(heldAt, context) {
  let release;
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  let entered;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  const calls = { source: 0, native: 0 };
  const thread = { id: 'thread', createdBy: 'owner' };
  const actor = {
    userId: 'owner',
    viewer: { type: 'cat', catId: 'codex61-sol' },
    source: { threadId: thread.id, messageId: 'trigger' },
  };
  let held = false;
  const wait = async (stage, result) => {
    if (stage === heldAt && !held) {
      held = true;
      entered();
      await waiting;
    }
    return result;
  };
  const nativeOptions = [];
  const service = new MessageSearchService({
    threadStore: { list: () => [thread], get: () => wait('source-thread', thread) },
    messageStore: {
      getById: (id) => {
        calls.source++;
        return wait('source-message', {
          id,
          threadId: thread.id,
          userId: actor.userId,
          content: 'PRIVATE_SOURCE_BODY',
          timestamp: 1,
        });
      },
    },
    evidenceStore: {
      readMessagePassageState: () => ({ current: true }),
      searchMessagePassages: (_query, options) => {
        calls.native++;
        nativeOptions.push(options);
        return wait('retrieval', { passages: [], meta: { effectiveMode: 'lexical', truncated: false } });
      },
    },
  });
  const source = service.discoverySource({ query: 'PRIVATE_QUERY' }, actor, context);
  const read = (execution = {}) => source.read({ query: 'PRIVATE_QUERY', limit: 10, ...execution });
  return { source, read, ready, release, calls, nativeOptions };
}

for (const phase of ['source-thread', 'source-message', 'retrieval'])
  for (const stop of ['cancel', 'deadline'])
    test(`native discovery stops after ${stop} during ${phase}, without later dispatch or late success`, async (t) => {
      let now = 1000;
      t.mock.method(Date, 'now', () => now);
      const controller = new AbortController();
      const f = fixture(phase);
      const pending = f.read({ signal: controller.signal, deadlineAt: 1100 });
      await f.ready;
      if (stop === 'cancel') controller.abort();
      else now = 1200;
      f.release();
      await assert.rejects(pending, { name: stop === 'cancel' ? 'AbortError' : 'TimeoutError' });
      assert.equal(f.calls.native, phase === 'retrieval' ? 1 : 0);
      if (phase === 'source-thread')
        assert.equal(f.calls.source, 0, 'expired source-thread admission cannot open source-message work');
    });

test('read progress preserves its pending stage, uses the existing native hook, and stays content free', async () => {
  const progress = [];
  const f = fixture('retrieval', { onReadProgress: (event) => progress.push(event) });
  const pending = f.read({ signal: new AbortController().signal, deadlineAt: Date.now() + 1000 });
  await f.ready;
  assert.deepEqual(
    progress.filter((row) => row.state === 'fulfilled').map((row) => row.stage),
    ['visibility', 'source-thread', 'source-message'],
  );
  assert.equal(progress.at(-1).stage, 'retrieval');
  assert.equal(progress.at(-1).state, 'pending');
  const hook = f.nativeOptions[0].onReadSnapshot;
  assert.equal(typeof hook, 'function');
  hook({
    phase: 'embedding-embed',
    outcome: 'pending',
    elapsedMs: 12,
    queueMs: 2,
    pid: 42,
    executionId: 'PRIVATE_COORDINATE',
    candidateAudit: { body: 'PRIVATE_BODY' },
    query: 'PRIVATE_QUERY',
  });
  const { observationAgeMs, ...native } = progress.at(-1).native;
  assert.deepEqual(native, { phase: 'embedding-embed', outcome: 'pending', elapsedMs: 12, queueMs: 2 });
  assert.ok(observationAgeMs >= 0);
  f.release();
  await pending;
  assert.equal(progress.at(-1).state, 'fulfilled');
  assert.doesNotMatch(JSON.stringify(progress), /PRIVATE_|pid|executionId|candidateAudit|query/);
  const length = progress.length;
  hook({ phase: 'sql-read', outcome: 'pending', elapsedMs: 99 });
  assert.equal(progress.length, length, 'an old native callback cannot publish after its read lifetime');
});

test('observer or hostile native snapshot failures do not replace successful reads or cancellation', async () => {
  const f = fixture('retrieval', {
    onReadProgress: () => {
      throw new Error('observer unavailable');
    },
  });
  const controller = new AbortController();
  const work = f.read({ signal: controller.signal });
  await f.ready;
  f.nativeOptions[0].onReadSnapshot?.({
    get phase() {
      throw new Error('hostile diagnostic');
    },
  });
  f.release();
  assert.deepEqual(await work, { candidates: [], truncated: false });
  const cancelled = fixture('source-message', {
    onReadProgress: () => {
      throw new Error('observer unavailable');
    },
  });
  const pending = cancelled.read({ signal: controller.signal });
  await cancelled.ready;
  controller.abort();
  cancelled.release();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(cancelled.calls.native, 0);
});

test('a replaced read cannot dispatch later work or overwrite the new lifetime progress', async () => {
  const progress = [];
  const f = fixture('source-message', { onReadProgress: (event) => progress.push(event) });
  const first = f.read({ signal: new AbortController().signal });
  await f.ready;
  const next = await f.read({ signal: new AbortController().signal });
  assert.deepEqual(next, { candidates: [], truncated: false });
  const atNext = JSON.stringify(progress);
  f.release();
  await assert.rejects(first, { name: 'AbortError' });
  assert.equal(f.calls.native, 1, 'only the next lifetime dispatches retrieval');
  assert.equal(JSON.stringify(progress), atNext);
});

for (const stop of ['cancel', 'deadline'])
  test(`an optional observer cannot open native work after ${stop}`, async (t) => {
    let now = 1000;
    t.mock.method(Date, 'now', () => now);
    const controller = new AbortController();
    const f = fixture('none', {
      onReadProgress: (event) => {
        if (event.stage === 'retrieval' && event.state === 'pending') {
          if (stop === 'cancel') controller.abort();
          else now = 1200;
          throw new Error('observer unavailable at the execution boundary');
        }
      },
    });
    await assert.rejects(f.read({ signal: controller.signal, deadlineAt: 1100 }), {
      name: stop === 'cancel' ? 'AbortError' : 'TimeoutError',
    });
    assert.equal(f.calls.native, 0);
  });

for (const stop of ['cancel', 'deadline'])
  test(`a fulfilled observer cannot return late native success after ${stop}`, async (t) => {
    let now = 1000;
    t.mock.method(Date, 'now', () => now);
    const controller = new AbortController();
    const f = fixture('none', {
      onReadProgress: (event) => {
        if (event.stage === 'retrieval' && event.state === 'fulfilled') {
          if (stop === 'cancel') controller.abort();
          else now = 1200;
        }
      },
    });
    await assert.rejects(f.read({ signal: controller.signal, deadlineAt: 1100 }), {
      name: stop === 'cancel' ? 'AbortError' : 'TimeoutError',
    });
    assert.equal(f.calls.native, 1, 'completed native work does not grant a late successful return');
  });
