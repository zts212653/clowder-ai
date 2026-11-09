import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { MemoryCueDrillHandleService } from '../../dist/domains/memory/cue/MemoryCueDrillHandleService.js';
import { MemoryCueEpisodeStore } from '../../dist/domains/memory/cue/MemoryCueEpisodeStore.js';
import { WorkPreparationOpportunityStore } from '../../dist/domains/memory/cue/preparation/WorkPreparationOpportunityStore.js';
import { WorkPreparationService } from '../../dist/domains/memory/cue/preparation/WorkPreparationService.js';
import { applyMigrations } from '../../dist/domains/memory/schema.js';
import { registerCallbackMemoryCueRoutes } from '../../dist/routes/callback-memory-cue-routes.js';

export function preparationFixture(t, overrides = {}) {
  const db = new Database(':memory:');
  applyMigrations(db);
  const episodes = new MemoryCueEpisodeStore(db);
  const opportunities = new WorkPreparationOpportunityStore(db);
  const scope = { ownerUserId: 'owner', threadId: 'thread', invocationId: 'inv' };
  const auth = {
    invocationId: 'inv',
    userId: 'owner',
    threadId: 'thread',
    catId: 'codex61-sol',
    originTriggerMessageId: 'trigger',
    ownerAuthProvenance: 'strict',
    state: 'active',
  };
  const handles = new MemoryCueDrillHandleService(Buffer.alloc(32, 7), {
    findPresentedCoordinate: (...args) => episodes.findPresentedCoordinate(...args),
    findPreparedCoordinate: (...args) => opportunities.findPreparedCoordinate(...args),
  });
  const state = { now: 1000, epoch: 1, current: true, readError: false, revision: 'r1', nativeSources: 1, hang: false };
  const nativeReads = [];
  const items = Array.from({ length: 4 }, (_, i) => ({
    family: 'project_knowledge',
    source: {
      title: 'Original source',
      summary: 'Check original conditions',
      anchor: `F${330 + i}`,
      revision: 'r1',
      visibility: 'owner_public',
      drillFamily: 'evidence',
    },
  }));
  const deps = {
    episodes,
    store: opportunities,
    handles,
    authority: {
      async bind() {
        return {
          scope,
          consumerCatId: auth.catId,
          contextEpoch: state.epoch,
          sourceMessageId: 'trigger',
          projectPath: '/project',
        };
      },
      async validate(record) {
        return state.current && record.contextEpoch === state.epoch;
      },
    },
    sources: {
      async create() {
        return Array.from({ length: state.nativeSources }, (_, i) => ({
          id: `documents-${i}`,
          read: async ({ limit, signal }) => {
            nativeReads.push(limit);
            if (state.hang)
              await new Promise((_resolve, reject) =>
                signal?.addEventListener('abort', () => reject(signal.reason), { once: true }),
              );
            return { candidates: items.slice(0, limit) };
          },
          project: async (candidate) => candidate,
          revalidate: async (item) => item,
          key: (item) => item.source.anchor,
        }));
      },
      async read(_record, request) {
        if (state.readError) throw new Error('reader unavailable');
        if (request.expectedRevision !== state.revision)
          return { status: 'not_available', invalidationReason: 'source_corrected' };
        return {
          status: 'ok',
          payload: { original: request.anchor, revision: request.expectedRevision, conditions: 'Only for this work' },
        };
      },
    },
  };
  const service = new WorkPreparationService({ ...deps, ...overrides });
  const app = Fastify();
  app.addHook('preHandler', async (request) => {
    request.callbackAuth = {
      ...auth,
      catId: request.headers['x-test-cat'] ?? auth.catId,
      threadId: String(request.headers['x-test-thread'] ?? auth.threadId),
      invocationId: String(request.headers['x-test-invocation'] ?? auth.invocationId),
    };
  });
  registerCallbackMemoryCueRoutes(app, {
    episodeStore: episodes,
    handles,
    preparation: service,
    now: () => state.now,
    sourceReader: { read: (request) => service.read(request) },
  });
  t.after(async () => {
    await app.close();
    db.close();
  });
  const post = (path, payload, headers = {}) =>
    app.inject({ method: 'POST', url: `/api/callbacks/memory-cues/${path}`, payload, headers });
  return { db, episodes, opportunities, handles, scope, auth, state, service, items, nativeReads, post, deps };
}
