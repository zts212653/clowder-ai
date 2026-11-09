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

export async function matterPreparationFixture(t) {
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
  const scope = { ownerUserId: actor.userId, threadId: auth.threadId, invocationId: auth.invocationId };
  const rows = Array.from({ length: 13 }, (_, index) => ({
    id: `source-${index}`,
    userId: actor.userId,
    threadId: 'history',
    from: { kind: 'user', userId: actor.userId },
    timestamp: 100,
    mentions: [],
    content: `PRIVATE_CANONICAL_CONDITION_${index}: preserve the named audience and original scope.`,
  }));
  const messages = new Map(rows.map((row) => [row.id, row]));
  messages.set('trigger', {
    ...rows[0],
    id: 'trigger',
    threadId: auth.threadId,
    content: 'Prepare this shared memo HTML.',
  });
  const history = { id: 'history', createdBy: actor.userId, projectPath: '/project' };
  const current = { id: auth.threadId, createdBy: actor.userId, projectPath: '/project' };
  const state = { tracking: false, pageReads: 0, messageReads: 0, beforeFinal: null, logs: [] };
  const threadStore = {
    get: (id) => (id === current.id ? current : id === history.id ? history : null),
    list: () => [current, history],
  };
  const messageStore = {
    getById: (id) => {
      if (state.tracking && id.startsWith('source-')) state.messageReads++;
      return messages.get(id) ?? null;
    },
  };
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
  const project = matters.project.bind(matters);
  matters.project = async (...args) => {
    if (state.tracking) state.pageReads++;
    return project(...args);
  };
  const episodes = new MemoryCueEpisodeStore(db);
  const opportunities = new WorkPreparationOpportunityStore(db);
  const handles = new MemoryCueDrillHandleService(Buffer.alloc(32, 7), {
    findPresentedCoordinate: (...args) => episodes.findPresentedCoordinate(...args),
    findPreparedCoordinate: (...args) => opportunities.findPreparedCoordinate(...args),
  });
  const owners = new OwnerPreparationSources({ matters, taste: { resolveExplicit: async () => null } });
  const service = new WorkPreparationService({
    episodes,
    store: opportunities,
    handles,
    logger: { warn: (fields) => state.logs.push(fields) },
    authority: new WorkPreparationAuthority({
      threads: threadStore,
      messages: messageStore,
      epochs: { get: () => ({ contextEpoch: 1 }) },
    }),
    sources: {
      read: (...args) => owners.read(...args),
      create: async (input) =>
        (await owners.create(input)).map((source) => ({
          ...source,
          revalidate: async (item) => {
            state.beforeFinal?.();
            return source.revalidate(item);
          },
        })),
    },
  });
  const app = Fastify();
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
  t.after(async () => {
    await app.close();
    db.close();
  });
  const prepare = async () => {
    state.pageReads = 0;
    state.messageReads = 0;
    state.tracking = true;
    try {
      return await app.inject({
        method: 'POST',
        url: '/api/callbacks/memory-cues/prepare',
        payload: { activity: 'html', query: 'w3allconditions' },
      });
    } finally {
      state.tracking = false;
    }
  };
  return {
    db,
    actor,
    auth,
    scope,
    rows,
    messages,
    history,
    current,
    matters,
    created,
    state,
    opportunities,
    episodes,
    app,
    service,
    prepare,
  };
}
