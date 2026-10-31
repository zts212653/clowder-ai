import Database from 'better-sqlite3';
import { AutoDreamStore } from '../../dist/domains/auto-dream/AutoDreamStore.js';
import { CatLifeSettingsService } from '../../dist/domains/auto-dream/CatLifeSettingsService.js';
import { ThreadStore } from '../../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { applyMigrations } from '../../dist/domains/memory/schema.js';
import { DynamicTaskStore } from '../../dist/infrastructure/scheduler/DynamicTaskStore.js';

export const OWNER = 'owner-a';
export const CAT = 'codex-sol';
export const ENABLED = {
  enabled: true,
  rhythm: { kind: 'gentle' },
  wakeTime: '22:30',
  timezone: 'America/Los_Angeles',
  quietHours: { start: '00:00', end: '08:00' },
};

export function resolveTestCat(mentionOrId) {
  const normalized = (mentionOrId.startsWith('@') ? mentionOrId.slice(1) : mentionOrId).toLowerCase();
  if (normalized === CAT) return { ok: CAT };
  if (normalized === 'disabled-cat') {
    return {
      error: {
        kind: 'cat_disabled',
        catId: 'disabled-cat',
        displayName: 'Disabled Cat',
        alternatives: [],
      },
    };
  }
  return { error: { kind: 'cat_not_found', mention: mentionOrId, alternatives: [] } };
}

function createRunner() {
  const registered = new Map();
  return {
    registered,
    unregister(id) {
      return registered.delete(id);
    },
    registerDynamic(spec, defId) {
      if (registered.has(spec.id)) throw new Error(`duplicate ${spec.id}`);
      registered.set(spec.id, { spec, defId });
    },
  };
}

function createTemplateRegistry() {
  return {
    get(id) {
      if (id !== 'present-loop') return null;
      return {
        createSpec(instanceId, params) {
          return {
            id: instanceId,
            trigger: params.trigger,
            display: { label: 'private time', category: 'system' },
          };
        },
      };
    },
  };
}

export async function createCatLifeServiceFixture() {
  let nowMs = Date.parse('2026-07-19T20:00:00Z');
  let catResolver = resolveTestCat;
  const store = new AutoDreamStore(':memory:', { now: () => nowMs });
  await store.initialize();
  const dynamicDb = new Database(':memory:');
  applyMigrations(dynamicDb);
  const dynamicStore = new DynamicTaskStore(dynamicDb);
  const threadStore = new ThreadStore();
  const runner = createRunner();
  const service = new CatLifeSettingsService({
    store,
    dynamicTaskStore: dynamicStore,
    taskRunner: runner,
    templateRegistry: createTemplateRegistry(),
    threadStore,
    privateOwnerUserId: OWNER,
    resolveCatTarget: (mentionOrId) => catResolver(mentionOrId),
    now: () => nowMs,
  });

  return {
    store,
    dynamicStore,
    threadStore,
    runner,
    service,
    now: () => nowMs,
    setNow: (value) => {
      nowMs = value;
    },
    setCatResolver: (resolver) => {
      catResolver = resolver;
    },
  };
}
