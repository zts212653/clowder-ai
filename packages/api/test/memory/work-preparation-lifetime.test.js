import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OwnerPreparationSources } from '../../dist/domains/memory/cue/preparation/OwnerPreparationSources.js';
import { WorkPreparationAuthority } from '../../dist/domains/memory/cue/preparation/WorkPreparationAuthority.js';
import { preparationFixture } from '../helpers/work-preparation-fixture.js';

const gate = () => {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
};
const turn = () => new Promise((resolve) => setImmediate(resolve));
const block = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const prepare = (f, signal = new AbortController().signal, deadlineAt) =>
  f.service.prepare({
    auth: f.auth,
    activity: 'html',
    query: 'neutral source query',
    receivedAt: Date.now(),
    signal,
    deadlineAt,
  });

test('cancellation during binding prevents preparation persistence and later source construction', async (t) => {
  const f = preparationFixture(t);
  const waiting = gate();
  f.deps.authority.bind = async () => {
    await waiting.promise;
    return {
      scope: f.scope,
      consumerCatId: f.auth.catId,
      contextEpoch: 1,
      sourceMessageId: 'trigger',
      projectPath: '/project',
    };
  };
  let created = 0;
  f.deps.sources.create = async () => {
    created++;
    return [];
  };
  const caller = new AbortController();
  const pending = prepare(f, caller.signal);
  await turn();
  caller.abort();
  waiting.release();
  assert.equal((await pending).status, 'cancelled');
  assert.equal(f.db.prepare('SELECT count(*) n FROM memory_cue_preparation_opportunities').get().n, 0);
  assert.equal(created, 0);
});

test('a factory timeout aborts its owned signal and prevents subsequent owner construction', async (t) => {
  const f = preparationFixture(t);
  const waiting = gate();
  let factorySignal;
  let laterOwners = 0;
  const owners = new OwnerPreparationSources({
    project: {
      discoverySource: async ({ signal }) => {
        factorySignal = signal;
        await waiting.promise;
        return null;
      },
    },
    messages: {
      discoverySource: () => {
        laterOwners++;
        return {};
      },
    },
    taste: { resolveExplicit: async () => null },
  });
  f.deps.sources.create = (input) => owners.create(input);
  const result = await prepare(f, new AbortController().signal, Date.now() + 350);
  assert.equal(result.status, 'source_unavailable');
  const abortedAtReturn = factorySignal.aborted;
  waiting.release();
  await turn();
  assert.equal(abortedAtReturn, true);
  assert.equal(laterOwners, 0);
});

test('a final authority read that crosses the absolute deadline cannot publish pointers', async (t) => {
  const f = preparationFixture(t);
  f.deps.authority.validate = async () => {
    block(450);
    return true;
  };
  const result = await prepare(f, new AbortController().signal, Date.now() + 350);
  assert.equal(result.status, 'source_unavailable');
  assert.deepEqual(result.pointers, []);
  assert.equal(f.db.prepare('SELECT count(*) n FROM memory_cue_events').get().n, 0);
});

test('the original authority stops between owner reads after its scope is cancelled', async () => {
  const waiting = gate();
  let laterReads = 0;
  const auth = {
    invocationId: 'inv',
    userId: 'owner',
    catId: 'codex61-sol',
    threadId: 'thread',
    originTriggerMessageId: 'trigger',
    ownerAuthProvenance: 'strict',
    state: 'active',
  };
  const authority = new WorkPreparationAuthority({
    threads: {
      get: async () => {
        await waiting.promise;
        return { id: 'thread', createdBy: 'owner' };
      },
    },
    messages: {
      getById: async () => {
        laterReads++;
        return null;
      },
    },
    epochs: {
      get: async () => {
        laterReads++;
        return null;
      },
    },
  });
  const caller = new AbortController();
  const pending = authority.bind(auth, { signal: caller.signal });
  caller.abort();
  waiting.release();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(laterReads, 0);
});

test('failure logs identify the owned stage and error class without source or query text', async (t) => {
  const events = [];
  const f = preparationFixture(t, { logger: { warn: (fields, message) => events.push({ fields, message }) } });
  const secret = 'PRIVATE_QUERY_AND_SOURCE_BODY_MUST_NOT_BE_LOGGED';
  f.deps.sources.create = async () => {
    throw Object.assign(new Error(secret), { code: 'SQLITE_BUSY' });
  };
  assert.equal((await prepare(f)).status, 'source_unavailable');
  assert.equal(events.length, 1);
  assert.equal(events[0].fields.stage, 'create');
  assert.equal(events[0].fields.errorClass, 'Error');
  assert.equal(events[0].fields.errorCode, 'SQLITE_BUSY');
  assert.equal(events[0].fields.invocationId, f.auth.invocationId);
  assert.ok(events[0].fields.elapsedMs >= 0);
  assert.equal(JSON.stringify(events).includes(secret), false);
  assert.equal(JSON.stringify(events).includes('neutral source query'), false);
  assert.equal(JSON.stringify(events).includes('callbackToken'), false);
});

test('synchronous metadata delay is reported at receive and cannot start source work after expiry', async (t) => {
  const logs = [];
  const f = preparationFixture(t, { logger: { warn: (fields) => logs.push(fields) } });
  const receive = f.opportunities.receive.bind(f.opportunities);
  f.opportunities.receive = (record) => {
    const r = receive(record);
    block(450);
    return r;
  };
  let created = 0;
  f.deps.sources.create = async () => {
    created++;
    return [];
  };
  const result = await prepare(f, new AbortController().signal, Date.now() + 350);
  assert.equal(result.status, 'source_unavailable');
  assert.equal(created, 0);
  assert.equal(logs[0].stage, 'receive');
  assert.equal(logs[0].errorName, 'TimeoutError');
});

test('late final metadata completion cannot return an already constructed pointer', async (t) => {
  const f = preparationFixture(t);
  const finish = f.opportunities.finish.bind(f.opportunities);
  f.opportunities.finish = (...args) => {
    finish(...args);
    if (args[1] === 'resolved') block(450);
  };
  const result = await prepare(f, new AbortController().signal, Date.now() + 350);
  assert.equal(result.status, 'source_unavailable');
  assert.deepEqual(result.pointers, []);
  assert.equal(f.db.prepare('SELECT count(*) n FROM memory_cue_events').get().n, 0);
});
