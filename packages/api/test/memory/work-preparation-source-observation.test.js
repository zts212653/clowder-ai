import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OwnerPreparationSources } from '../../dist/domains/memory/cue/preparation/OwnerPreparationSources.js';
import { projectPreparationSource } from '../../dist/domains/memory/cue/preparation/project-preparation-source.js';
import { preparationFixture } from '../helpers/work-preparation-fixture.js';

function gate() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
const turn = () => new Promise((resolve) => setImmediate(resolve));

for (const [family, phase] of [
  ['project_knowledge', 'read'],
  ['message_evidence', 'project'],
  ['project_knowledge', 'revalidate'],
])
  test(`failed preparation identifies an unsettled ${family}/${phase} without reporting it as settled`, async (t) => {
    const waiting = gate();
    const logs = [];
    const secret = 'PRIVATE_QUERY_TITLE_PATH_BODY';
    const f = preparationFixture(t, { logger: { warn: (fields) => logs.push(fields) } });
    const native = (tag, item) => {
      const run = async (at, value) => {
        if (tag === family && at === phase) await waiting.promise;
        return value;
      };
      return {
        id: `${secret}/${tag}`,
        read: () => run('read', { candidates: [item] }),
        project: (candidate) => run('project', candidate),
        revalidate: (row) => run('revalidate', row),
        key: () => tag,
      };
    };
    const owners = new OwnerPreparationSources({
      project: {
        discoverySource: async () =>
          native('project_knowledge', {
            anchor: 'neutral-doc',
            revision: 'r1',
            title: secret,
            summary: secret,
            visibility: 'owner_private',
            drillFamily: 'evidence',
          }),
      },
      messages: {
        discoverySource: () =>
          native('message_evidence', {
            threadId: 'history',
            messageId: 'message',
            contentRevision: 'r1',
            result: { timestamp: 1 },
            body: secret,
          }),
      },
      taste: { resolveExplicit: async () => null },
    });
    f.deps.sources.create = (input) => owners.create(input);
    const result = await f.service.prepare({
      auth: f.auth,
      activity: 'html',
      query: secret,
      receivedAt: Date.now(),
      deadlineAt: Date.now() + 400,
      signal: new AbortController().signal,
    });
    assert.equal(result.status, 'source_unavailable');
    assert.deepEqual(result.pointers, []);
    assert.equal(logs.length, 1);
    assert.ok(Array.isArray(logs[0].sourcePhases), 'failure must carry bounded source/subphase observations');
    assert.equal(logs[0].sourcePhases.length, 2);
    const observed = logs[0].sourcePhases.find((source) => source.family === family).phases[phase];
    assert.equal(observed.state, 'pending');
    assert.equal(observed.calls, 1);
    assert.equal(observed.pending, 1);
    assert.equal(observed.settled, 0);
    assert.ok(observed.elapsedMs >= 0);
    assert.equal(JSON.stringify(logs).includes(secret), false);
    const atFailure = JSON.stringify(logs);
    waiting.release();
    await turn();
    assert.equal(JSON.stringify(logs), atFailure, 'late settlement must not mutate the recorded snapshot');
  });

test('observation hook failures cannot replace native results or original failures', async () => {
  const original = new Error('original source error');
  const native = {
    id: 'neutral',
    read: async () => ({ candidates: ['candidate'] }),
    project: async () => 'item',
    revalidate: async () => {
      throw original;
    },
    key: (v) => v,
  };
  const item = { family: 'matter', source: { anchor: 'matter:neutral', revision: 'revision:1' } };
  for (const observer of [
    () => {
      throw new Error('broken observer');
    },
    () => () => {
      throw new Error('broken settlement');
    },
  ]) {
    const source = projectPreparationSource(native, async () => item, observer);
    assert.deepEqual(await source.read({ query: 'neutral', limit: 1 }), { candidates: ['candidate'] });
    assert.equal((await source.project('candidate')).source.anchor, item.source.anchor);
    await assert.rejects(source.revalidate({ ...item, native: 'item' }), (error) => error === original);
  }
});

test('a failed diagnostic logger cannot replace cancellation or its original response', async (t) => {
  const f = preparationFixture(t, {
    logger: {
      warn: () => {
        throw new Error('logger offline');
      },
    },
  });
  const caller = new AbortController();
  caller.abort();
  const result = await f.service.prepare({
    auth: f.auth,
    activity: 'html',
    query: 'neutral',
    receivedAt: Date.now(),
    signal: caller.signal,
  });
  assert.equal(result.status, 'cancelled');
  assert.deepEqual(result.pointers, []);
});
