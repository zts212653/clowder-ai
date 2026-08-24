import assert from 'node:assert/strict';
import { catRegistry } from '@cat-cafe/shared';

export const { SessionChainStore } = await import('../../dist/domains/cats/services/stores/ports/SessionChainStore.js');
const { InMemoryContextEpochStore } = await import(
  '../../dist/domains/cats/services/stores/ports/ContextEpochStore.js'
);
const { ContextEpochOwner } = await import('../../dist/domains/cats/services/session/ContextEpochOwner.js');
const { logger } = await import('../../dist/infrastructure/logger.js');

export const SERIAL_DEGRADED_MESSAGE =
  '[routeSerial] session bootstrap rebuild returned no sealed prior; degrading to initial bootstrap context';
export const PARALLEL_DEGRADED_MESSAGE =
  '[routeParallel] session bootstrap rebuild returned no sealed prior; degrading to initial bootstrap context';
export const REMEDIAL_DEGRADED_MESSAGE =
  '[routeSerial] remedial session bootstrap rebuild returned no sealed prior; degrading to bare remedial prompt';

const moduleLoggers = new Map();
const originalModuleWarns = new Map();
const originalChild = logger.child.bind(logger);
logger.child = (bindings) => {
  const child = originalChild(bindings);
  if (bindings && typeof bindings.module === 'string') moduleLoggers.set(bindings.module, child);
  return child;
};

export function captureWarns(moduleName) {
  const child = moduleLoggers.get(moduleName);
  const warns = [];
  if (!child) return warns;
  if (!originalModuleWarns.has(moduleName)) originalModuleWarns.set(moduleName, child.warn.bind(child));
  const originalWarn = originalModuleWarns.get(moduleName);
  child.warn = (...args) => {
    warns.push(args);
    return originalWarn(...args);
  };
  return warns;
}

export function countDegradationWarnings(warns, { catId, message }) {
  return warns.filter(([fields, msg]) => fields?.catId === catId && msg === message).length;
}

let catRegistryLock = Promise.resolve();

async function withCatRegistryLock(fn) {
  const previous = catRegistryLock;
  let release;
  catRegistryLock = new Promise((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

export function createHandshakeService(catId, turns) {
  const calls = [];
  return {
    calls,
    contextCapability() {
      return {
        provider: 'openai',
        carrier: 'exec_json',
        reportsRuntimeWindow: true,
        authoritativeUsage: false,
        usageTelemetry: 'available',
        nativeWindowControl: true,
        nativeCompressionControl: false,
        observesCompression: true,
        reason: 'test carrier',
      };
    },
    async *invoke(prompt) {
      calls.push(prompt);
      yield {
        type: 'system_info',
        catId,
        content: JSON.stringify({ type: 'invocation_created', invocationId: `${catId}-inv-${calls.length}` }),
        timestamp: Date.now(),
      };
      const turn = turns[Math.min(calls.length - 1, turns.length - 1)] ?? '';
      const events = Array.isArray(turn) ? turn : [{ type: 'text', content: turn }];
      for (const event of events) yield { catId, timestamp: Date.now(), ...event };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

function countingChain(store) {
  const callsByCat = new Map();
  const wrapper = Object.create(Object.getPrototypeOf(store), Object.getOwnPropertyDescriptors(store));
  wrapper.getChain = (catId, ...args) => {
    callsByCat.set(catId, (callsByCat.get(catId) ?? 0) + 1);
    return store.getChain(catId, ...args);
  };
  wrapper.getChainCalls = (catId) => callsByCat.get(catId) ?? 0;
  return wrapper;
}

export function failingRebuildChain(store, error) {
  let getChainCalls = 0;
  const wrapper = Object.create(Object.getPrototypeOf(store), Object.getOwnPropertyDescriptors(store));
  wrapper.getChain = (...args) => {
    getChainCalls += 1;
    if (getChainCalls === 3) throw error;
    return store.getChain(...args);
  };
  wrapper.getChainCalls = () => getChainCalls;
  return wrapper;
}

export function createProjectionService({ state, closeDecisions }) {
  const closes = [];
  return {
    closes,
    async open() {
      return {
        state,
        evidenceRefs: ['wake:test'],
        ...(state === 'covered_active' ? { baseline: { kind: 'test' } } : {}),
      };
    },
    async close(projection) {
      const next = closeDecisions[Math.min(closes.length, closeDecisions.length - 1)];
      const decision = { state, ...next, evidenceRefs: [...projection.evidenceRefs] };
      closes.push(decision);
      return decision;
    },
  };
}

function createMockDeps(
  services,
  appended,
  { turnCustodyProjectionService, sessionChainStore, sessionSealer, transcriptReader, sessionManager } = {},
) {
  let sequence = 0;
  return {
    services,
    invocationDeps: {
      registry: {
        create: () => ({ invocationId: `outer-inv-${++sequence}`, callbackToken: `tok-${sequence}` }),
        verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      sessionManager: {
        getOrCreate: async () => ({}),
        get: async (_userId, catId) => `cli-session-${catId}`,
        delete: async () => {},
        resolveWorkingDirectory: () => '/tmp/test',
        ...sessionManager,
      },
      threadStore: null,
      apiUrl: 'http://127.0.0.1:3004',
      contextEpochOwner: new ContextEpochOwner(new InMemoryContextEpochStore()),
      ...(sessionChainStore ? { sessionChainStore } : {}),
      ...(sessionSealer ? { sessionSealer } : {}),
      ...(transcriptReader ? { transcriptReader } : {}),
    },
    messageStore: {
      append: async (message) => {
        const stored = {
          id: `stored-${++sequence}`,
          userId: message.userId ?? '',
          catId: message.catId ?? null,
          content: message.content ?? '',
          mentions: message.mentions ?? [],
          timestamp: message.timestamp ?? 0,
          source: message.source,
          origin: message.origin,
          mentionsUser: message.mentionsUser,
          toolEvents: message.toolEvents,
          extra: message.extra,
        };
        appended.push(stored);
        return stored;
      },
      getById: async () => null,
      getRecent: async () => [],
      getMentionsFor: async () => [],
      getBefore: async () => [],
      getByThread: async () => [],
      getByThreadAfter: async () => [],
      getByThreadBefore: async () => [],
      augmentStreamMetadata: async () => true,
    },
    draftStore: {
      upsert: () => {},
      touch: () => {},
      delete: async () => {},
      deleteByThread: () => {},
      getByThread: () => [],
    },
    socketManager: { broadcastToRoom: () => {} },
    turnCustodyProjectionService,
  };
}

export async function runRoute(
  route,
  services,
  threadId,
  { targetCats = ['codex'], projectionService, routeOptions = {}, sessionChainStore } = {},
) {
  return withCatRegistryLock(async () => {
    const original = catRegistry.getAllConfigs();
    const { loadCatConfig, toAllCatConfigs } = await import('../../dist/config/cat-config-loader.js');
    catRegistry.reset();
    for (const [id, config] of Object.entries(toAllCatConfigs(loadCatConfig()))) catRegistry.register(id, config);
    const appended = [];
    try {
      const deps = createMockDeps(services, appended, {
        turnCustodyProjectionService: projectionService,
        sessionChainStore: sessionChainStore ?? countingChain(new SessionChainStore()),
        sessionSealer: {
          async requestSeal() {
            return { accepted: false, status: 'rejected', sessionId: 'seal-none' };
          },
          async finalize() {},
        },
        transcriptReader: { readDigest: async () => null },
      });
      const yielded = [];
      for await (const message of route(deps, targetCats, 'cold rebuild probe', 'user1', threadId, {
        invocationController: new AbortController(),
        trackA2ASlot: () => true,
        completeA2ASlots: () => {},
        ...routeOptions,
      })) {
        yielded.push(message);
      }
      return { appended, yielded, deps };
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(original)) catRegistry.register(id, config);
    }
  });
}

export function assertDegradedInvocations({ yielded, service, catId, getChainCalls }) {
  assert.ok(
    getChainCalls(catId) >= 2,
    `${catId}'s rebuild must re-query the chain (getChain calls: ${getChainCalls(catId)})`,
  );
  const own = yielded.filter((message) => message.catId === catId);
  const errors = own.filter(
    (message) => message.type === 'error' || message.error === true || message.isError === true,
  );
  assert.deepEqual(
    errors.map((message) => message.content ?? message.error),
    [],
    `Session #1 cold-rebuild must not fail ${catId}'s invocation`,
  );
  assert.ok(
    own.some((message) => message.type === 'done'),
    `${catId}'s invocation must complete`,
  );
  for (const prompt of service.calls) {
    assert.doesNotMatch(prompt, /\[Session Continuity/, `${catId} has no prior to inject`);
  }
}
