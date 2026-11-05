import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  readLiveCompanionWorkCandidates as read,
  resolveLiveCompanionWorkPublication as resolve,
} from '../src/domains/concierge/live/work/live-companion-work.ts';
import { workFixture } from './helpers/f317-companion-work-fixture.mjs';

async function fixture(t) {
  const f = await workFixture(t, {
    artifactWorkLineage: {
      resolve: async ({ artifacts }) =>
        artifacts.map(() => ({ contentRef: 'prepared-media:checklist', ownerRevision: 1, currentOwnerRevision: 1 })),
    },
  });
  return { ...f, scope: { userId: 'owner', catId: 'codex', threadId: f.thread.id } };
}

test('normal Live reads a bounded cat-visible publication and opens its exact owner version', async (t) => {
  const f = await fixture(t);
  const source = f.publish('清单.md');
  const [candidate] = await read(f.options, f.scope);
  assert.ok(candidate, 'a readable prepared publication must be offered to normal Live');
  assert.match(candidate.label, /清单.md/);
  assert.deepEqual(candidate.destination, {
    threadId: f.thread.id,
    messageId: source.id,
    item: { kind: 'rich-file', blockId: '清单.md' },
    sourceRef: `message:${f.thread.id}:${source.id}`,
    artifact: { contentRef: 'prepared-media:checklist', ownerRevision: 1 },
  });
  assert.deepEqual(await resolve(f.options, f.scope, candidate), {
    source: {
      kind: 'message',
      threadId: f.thread.id,
      messageId: source.id,
      messageRevision: String(source.timestamp),
      item: candidate.destination.item,
      expectedUrl: '/uploads/清单.md',
    },
    artifact: candidate.destination.artifact,
  });
  assert.equal(f.tasks.listByThread(f.thread.id).length, 0);
  assert.equal(f.messages.getByThread(f.thread.id).length, 1);
});

for (const [reason, revoke] of Object.entries({
  private: (m) => {
    m.visibility = 'whisper';
    m.whisperTo = ['sonnet'];
  },
  recalled: (m) => {
    m.recall = { recalledAt: Date.now(), recalledBy: 'owner' };
  },
  deleted: (m) => {
    m.deletedAt = 0;
  },
  tombstone: (m) => {
    m._tombstone = true;
  },
  canceled: (m) => {
    m.deliveryStatus = 'canceled';
  },
  noticeOnly: (m) => {
    m.deliveryStatus = 'queued';
    m.origin = 'briefing';
  },
  ownerChanged: (m) => {
    m.userId = 'other';
  },
  threadChanged: (m) => {
    m.threadId = 'other';
  },
}))
  test(`${reason} is neither offered nor resolvable from an earlier candidate`, async (t) => {
    const f = await fixture(t);
    const source = f.publish('不能泄露.md');
    const [candidate] = await read(f.options, f.scope);
    assert.ok(candidate);
    revoke(source);
    assert.deepEqual(await read(f.options, f.scope), []);
    assert.equal(await resolve(f.options, f.scope, candidate), null);
  });

test('published queued real-cat speech is readable, but a queue notice does not override whisper privacy', async (t) => {
  const f = await fixture(t);
  const source = f.publish('回流.md');
  source.deliveryStatus = 'queued';
  source.origin = 'callback';
  assert.equal((await read(f.options, f.scope)).length, 1);
  source.visibility = 'whisper';
  source.whisperTo = ['sonnet'];
  assert.deepEqual(await read(f.options, f.scope), []);
});

test('requires exact owner, current project/thread and canonical lineage; no labels reach lineage before ACL', async (t) => {
  const f = await fixture(t);
  const source = f.publish('私密.md');
  assert.deepEqual(await read(f.options, { ...f.scope, userId: 'other' }), []);
  assert.deepEqual(await read({ ...f.options, projectPath: '/other' }, f.scope), []);
  assert.deepEqual(await read(f.options, { ...f.scope, threadId: 'other' }), []);
  assert.deepEqual(await read({ ...f.options, artifactLineage: undefined }, f.scope), []);
  for (const result of [[], [undefined]])
    assert.deepEqual(await read({ ...f.options, artifactLineage: { resolve: async () => result } }, f.scope), []);
  source.visibility = 'whisper';
  source.whisperTo = ['sonnet'];
  assert.deepEqual(
    await read(
      { ...f.options, artifactLineage: { resolve: async () => assert.fail('private title entered lineage') } },
      f.scope,
    ),
    [],
  );
});

test('candidate seals exact source and version, while a new current version does not revoke the original', async (t) => {
  const f = await fixture(t);
  const source = f.publish('清单.md');
  const [candidate] = await read(f.options, f.scope);
  assert.ok(candidate);
  for (const field of ['id', 'label', 'revision'])
    assert.equal(await resolve(f.options, f.scope, { ...candidate, [field]: 'forged' }), null);
  assert.equal(
    await resolve(f.options, f.scope, { ...candidate, destination: { ...candidate.destination, sourceRef: 'forged' } }),
    null,
  );
  f.options.artifactLineage = {
    resolve: async () => [{ contentRef: 'prepared-media:checklist', ownerRevision: 1, currentOwnerRevision: 2 }],
  };
  assert.ok(await resolve(f.options, f.scope, candidate));
  f.options.artifactLineage = {
    resolve: async () => [{ contentRef: 'prepared-media:checklist', ownerRevision: 2, currentOwnerRevision: 2 }],
  };
  assert.equal(await resolve(f.options, f.scope, candidate), null);
  f.options.artifactLineage = {
    resolve: async () => [{ contentRef: 'prepared-media:checklist', ownerRevision: 1, currentOwnerRevision: 1 }],
  };
  source.extra.rich.blocks[0].url = '/uploads/replaced.md';
  assert.equal(await resolve(f.options, f.scope, candidate), null);
});

test('rechecks source/project after asynchronous lineage, rejects expired Host before and after IO', async (t) => {
  for (const revoke of ['source', 'project', 'host']) {
    const f = await fixture(t);
    const source = f.publish('清单.md');
    let current = true;
    f.options.assertCurrent = async () => {
      if (!current) throw new Error('expired Host');
    };
    f.options.artifactLineage = {
      resolve: async () => {
        if (revoke === 'source') source.extra.rich.blocks[0].url = '/uploads/changed.md';
        if (revoke === 'project') f.thread.projectPath = '/other';
        if (revoke === 'host') current = false;
        return [{ contentRef: 'prepared-media:checklist', ownerRevision: 1, currentOwnerRevision: 1 }];
      },
    };
    if (revoke === 'host') await assert.rejects(read(f.options, f.scope), /expired Host/);
    else assert.deepEqual(await read(f.options, f.scope), []);
  }
  const f = await fixture(t);
  await assert.rejects(
    read(
      {
        ...f.options,
        assertCurrent: async () => {
          throw new Error('expired Host');
        },
      },
      f.scope,
    ),
    /expired Host/,
  );
});

test('at most eight choices, one batch owner lookup, and a valid exact candidate outlives the recent window', async (t) => {
  const f = await fixture(t);
  f.publish('first.md', 1);
  const [candidate] = await read(f.options, f.scope);
  assert.ok(candidate);
  for (let i = 0; i < 40; i++) f.publish(`${i}.md`, 100 + i);
  let scans = 0;
  const original = f.options.artifactLineage.resolve;
  f.options.artifactLineage.resolve = async (input) => {
    scans++;
    return original(input);
  };
  assert.equal((await read(f.options, f.scope)).length, 8);
  assert.equal(scans, 1);
  assert.ok(await resolve(f.options, f.scope, candidate));
});
