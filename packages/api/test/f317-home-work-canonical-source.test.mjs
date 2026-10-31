import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConciergeThreadService } from '../src/domains/concierge/ConciergeThreadService.ts';
import { createHomeWorkSource } from '../src/domains/concierge/live/host/home/home-work-source.ts';
import { workFixture } from './helpers/f317-companion-work-fixture.mjs';

async function fixture(t, canonicalPort = true) {
  const lineage = {
    resolve: async ({ artifacts }) =>
      artifacts.map(() => ({ contentRef: 'prepared-media:host-canonical', ownerRevision: 1, currentOwnerRevision: 1 })),
  };
  const f = await workFixture(t);
  const concierge = new ConciergeThreadService({ threadStore: f.threads });
  const threadId = await concierge.getOrCreate('owner');
  assert.equal(f.threads.get(threadId).projectPath, 'default');
  const publication = f.messages.append({
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
  const source = createHomeWorkSource({
    ownerUserId: 'owner',
    projectPath: () => f.options.projectPath,
    messages: f.messages,
    threads: f.threads,
    tasks: f.tasks,
    lineage: () => lineage,
    ...(canonicalPort ? { isCurrentCompanionThread: (userId, id) => concierge.isCurrent(userId, id) } : {}),
  });
  return { ...f, concierge, source, publication, scope: { userId: 'owner', catId: 'codex', threadId } };
}

test('Host factory uses the real owner canonical authority for default carriers and exact publication consumption', async (t) => {
  const f = await fixture(t);
  const [candidate] = await f.source.read(f.scope, async () => {});
  assert.ok(candidate, 'canonical publication must pass through the production Host factory');
  const publication = await f.source.resolve(f.scope, candidate, async () => {});
  assert.equal(publication.source.threadId, f.scope.threadId);
  assert.equal(publication.source.messageId, f.publication.id);
  assert.equal(publication.artifact.contentRef, 'prepared-media:host-canonical');
  f.threads.updateThreadKind(f.scope.threadId, 'chat');
  assert.equal(await f.concierge.isCurrent('owner', f.scope.threadId), false);
  assert.equal(await f.source.resolve(f.scope, candidate, async () => {}), null);
  assert.deepEqual(await f.source.read(f.scope, async () => {}), []);
});

test('Host factory without canonical authority does not admit an arbitrary default carrier', async (t) => {
  const f = await fixture(t, false);
  assert.deepEqual(await f.source.read(f.scope, async () => {}), []);
});

test('the bound Host factory refuses a foreign owner even for its real canonical carrier', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.source.read({ ...f.scope, userId: 'other' }, async () => {}), []);
});
