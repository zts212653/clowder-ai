import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { MemoryCueDrillHandleService } from '../../dist/domains/memory/cue/MemoryCueDrillHandleService.js';
import { MemoryCueEpisodeStore } from '../../dist/domains/memory/cue/MemoryCueEpisodeStore.js';
import { OwnerPreparationSources } from '../../dist/domains/memory/cue/preparation/OwnerPreparationSources.js';
import { WorkPreparationAuthority } from '../../dist/domains/memory/cue/preparation/WorkPreparationAuthority.js';
import { WorkPreparationOpportunityStore } from '../../dist/domains/memory/cue/preparation/WorkPreparationOpportunityStore.js';
import { WorkPreparationService } from '../../dist/domains/memory/cue/preparation/WorkPreparationService.js';
import { MatterMemoryService } from '../../dist/domains/memory/matters/MatterMemoryService.js';
import { applyMigrations } from '../../dist/domains/memory/schema.js';
import { registerCallbackMemoryCueRoutes } from '../../dist/routes/callback-memory-cue-routes.js';

test('a prepared Matter returns every supporting condition beyond twelve and records exactly those reads', async (t) => {
  const db = new Database(':memory:');
  applyMigrations(db);
  const actor = { userId: 'owner', viewer: { type: 'cat', catId: 'codex61-sol' } };
  const auth = {
    invocationId: 'inv',
    userId: actor.userId,
    catId: actor.viewer.catId,
    threadId: 'thread',
    originTriggerMessageId: 'trigger',
    ownerAuthProvenance: 'strict',
    state: 'active',
  };
  const rows = Array.from({ length: 13 }, (_, index) => ({
    id: `source-${index}`,
    userId: actor.userId,
    threadId: 'thread',
    from: { kind: 'user', userId: actor.userId },
    timestamp: 100,
    mentions: [],
    content: `Condition ${index + 1}: preserve the named audience and original scope.`,
  }));
  const messages = new Map(rows.map((row) => [row.id, row]));
  messages.set('trigger', { ...rows[0], id: 'trigger', content: 'Prepare this shared memo HTML.' });
  const threadStore = {
    get: () => ({ id: 'thread', createdBy: actor.userId, projectPath: '/project' }),
    list: () => [{ id: 'thread', createdBy: actor.userId }],
  };
  const messageStore = { getById: (id) => messages.get(id) ?? null };
  const matters = new MatterMemoryService({ db, runWrite: (operation) => operation(), messageStore, threadStore });
  const created = await matters.write(actor, {
    operation: 'create',
    requestId: 'thirteen-conditions',
    title: 'html w3allconditions',
    description: 'All thirteen conditions apply to this named shared memo.',
    sources: rows.map((row) => ({
      threadId: row.threadId,
      messageId: row.id,
      segment: 'body',
      start: 0,
      end: row.content.length,
      quote: row.content,
    })),
  });
  assert.equal((await matters.project(actor, created.matter.matterId)).entries.length, 13);
  const episodes = new MemoryCueEpisodeStore(db);
  const opportunities = new WorkPreparationOpportunityStore(db);
  const handles = new MemoryCueDrillHandleService(Buffer.alloc(32, 7), {
    findPresentedCoordinate: (...args) => episodes.findPresentedCoordinate(...args),
    findPreparedCoordinate: (...args) => opportunities.findPreparedCoordinate(...args),
  });
  const service = new WorkPreparationService({
    episodes,
    store: opportunities,
    handles,
    authority: new WorkPreparationAuthority({
      threads: threadStore,
      messages: messageStore,
      epochs: { get: () => ({ contextEpoch: 1 }) },
    }),
    sources: new OwnerPreparationSources({ matters, taste: { resolveExplicit: async () => null } }),
  });
  const app = Fastify();
  t.after(async () => {
    await app.close();
    db.close();
  });
  app.addHook('preHandler', async (request) => {
    request.callbackAuth = auth;
  });
  registerCallbackMemoryCueRoutes(app, {
    handles,
    episodeStore: episodes,
    preparation: service,
    now: Date.now,
    sourceReader: { read: (request) => service.read(request) },
  });
  const prepare = await app.inject({
    method: 'POST',
    url: '/api/callbacks/memory-cues/prepare',
    payload: { activity: 'html', query: 'w3allconditions' },
  });
  assert.equal(prepare.statusCode, 200, prepare.body);
  const [pointer] = prepare.json().pointers;
  assert.ok(pointer, prepare.body);
  const read = await app.inject({
    method: 'POST',
    url: '/api/callbacks/memory-cues/drill',
    payload: { handle: pointer.read.handle, requestId: 'read-all-conditions' },
  });
  assert.equal(read.statusCode, 200, read.body);
  const page = read.json().payload;
  assert.deepEqual(page.entries.map((entry) => entry.quote).sort(), rows.map((row) => row.content).sort());
  assert.equal(page.nextCursor, undefined, 'this complete read has no omitted supporting source');
  const actual = page.entries.map((entry) => ({ entryId: entry.entryId, sourceRevision: entry.source.sourceRevision }));
  const receipts = episodes.listByCue(actor.userId, pointer.cueId);
  assert.deepEqual(
    receipts.map((receipt) => receipt.consumptionOutcome),
    ['presented', 'drilled'],
  );
  for (const receipt of receipts) assert.deepEqual(receipt.readDetails.entries, actual);
});
