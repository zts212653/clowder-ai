import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConciergeThreadService } from '../src/domains/concierge/ConciergeThreadService.ts';
import { readCompanionWork } from '../src/domains/concierge/live/work/companion-work-read.ts';
import {
  readLiveCompanionWorkCandidates as read,
  resolveLiveCompanionWorkPublication as resolve,
} from '../src/domains/concierge/live/work/live-companion-work.ts';
import { workFixture } from './helpers/f317-companion-work-fixture.mjs';

async function fixture(t) {
  const f = await workFixture(t, {
    artifactWorkLineage: {
      resolve: async ({ artifacts }) =>
        artifacts.map(() => ({ contentRef: 'prepared-media:canonical', ownerRevision: 1, currentOwnerRevision: 1 })),
    },
  });
  const concierge = new ConciergeThreadService({ threadStore: f.threads });
  const threadId = await concierge.getOrCreate('owner');
  const thread = f.threads.get(threadId);
  assert.equal(thread.projectPath, 'default');
  assert.equal(thread.threadKind, 'concierge');
  assert.equal(await concierge.isCurrent('owner', threadId), true);
  const source = f.messages.append({
    userId: 'owner',
    threadId,
    from: { kind: 'agent', catId: 'codex-sol' },
    content: '交回家清单',
    mentions: ['codex'],
    timestamp: Date.now(),
    extra: {
      rich: {
        v: 1,
        blocks: [
          {
            kind: 'file',
            v: 1,
            id: 'checklist',
            fileName: '回家清单.png',
            url: '/uploads/canonical.png',
            mimeType: 'image/png',
          },
        ],
      },
    },
  });
  const scope = { userId: 'owner', catId: 'codex', threadId };
  const options = { ...f.options, isCurrentCompanionThread: (userId, id) => concierge.isCurrent(userId, id) };
  return { ...f, thread, source, scope, options, concierge };
}

test('the real canonical companion carrier can return its own readable original publication', async (t) => {
  const f = await fixture(t);
  const [candidate] = await read(f.options, f.scope);
  assert.ok(
    candidate,
    'ordinary canonical Live publication must not disappear solely because its carrier projectPath is default',
  );
  const publication = await resolve(f.options, f.scope, candidate);
  assert.equal(publication.source.messageId, f.source.id);
  assert.equal(publication.artifact.contentRef, 'prepared-media:canonical');
  assert.equal(
    (await readCompanionWork(f.options)).deliveries.items.length,
    0,
    'human project overview stays project-scoped',
  );
});

test('canonical authority supports legacy createdBy without broadening the source message owner', async (t) => {
  const f = await fixture(t);
  f.thread.createdBy = 'legacy-system';
  const [candidate] = await read(f.options, f.scope);
  assert.ok(candidate);
  f.source.userId = 'other';
  assert.deepEqual(await read(f.options, f.scope), []);
  assert.equal(await resolve(f.options, f.scope, candidate), null);
});

test('missing Host port, another owner and merely concierge-shaped default threads have no authority', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await read({ ...f.options, isCurrentCompanionThread: undefined }, f.scope), []);
  assert.deepEqual(await read(f.options, { ...f.scope, userId: 'other' }), []);
  assert.deepEqual(await read({ ...f.options, ownerUserId: 'other' }, { ...f.scope, userId: 'other' }), []);
  const fake = f.threads.create('owner', f.thread.title);
  f.threads.updateThreadKind(fake.id, 'concierge');
  f.source.threadId = fake.id;
  assert.deepEqual(await read(f.options, { ...f.scope, threadId: fake.id }), []);
});

for (const [reason, revoke] of Object.entries({
  deleted: (f) => f.threads.softDelete(f.thread.id),
  kindChanged: (f) => f.threads.updateThreadKind(f.thread.id, null),
  replacedCanonical: async (f) => {
    f.threads.softDelete(f.thread.id);
    assert.notEqual(await f.concierge.getOrCreate('owner'), f.thread.id);
    f.threads.restore(f.thread.id);
  },
})) {
  test(`${reason} canonical carrier rejects both discovery and an earlier candidate`, async (t) => {
    const f = await fixture(t);
    const [candidate] = await read(f.options, f.scope);
    assert.ok(candidate);
    await revoke(f);
    assert.deepEqual(await read(f.options, f.scope), []);
    assert.equal(await resolve(f.options, f.scope, candidate), null);
  });
  test(`${reason} during lineage IO cannot publish an earlier canonical result`, async (t) => {
    const f = await fixture(t);
    const [candidate] = await read(f.options, f.scope);
    const original = f.options.artifactLineage.resolve;
    f.options.artifactLineage = {
      resolve: async (input) => {
        await revoke(f);
        return original(input);
      },
    };
    assert.equal(await resolve(f.options, f.scope, candidate), null);
  });
}

test('Host revocation while checking canonical authority fails before publication reads', async (t) => {
  const f = await fixture(t);
  let current = true;
  f.options.assertCurrent = async () => {
    if (!current) throw new Error('expired Host');
  };
  f.options.isCurrentCompanionThread = async (owner, thread) => {
    const valid = await f.concierge.isCurrent(owner, thread);
    current = false;
    return valid;
  };
  f.options.messages = { ...f.options.messages, getByThread: () => assert.fail('read after Host revocation') };
  await assert.rejects(read(f.options, f.scope), /expired Host/);
});
