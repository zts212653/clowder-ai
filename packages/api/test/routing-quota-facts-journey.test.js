import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { routeSerial } from '../dist/domains/cats/services/agents/routing/route-serial.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { buildRoutingSignalDecisionProjection } from '../dist/domains/routing-context/preflight/RoutingSignalDecisionProjection.js';
import { RoutingContextReadService } from '../dist/domains/routing-context/RoutingContextReadService.js';
import { RoutingContextResolver } from '../dist/domains/routing-context/RoutingContextResolver.js';
import { RuntimeRoutingDispatchPreflight } from '../dist/domains/routing-context/RoutingDispatchPreflightPort.js';
import { RoutingPreflightService } from '../dist/domains/routing-context/RoutingPreflightService.js';
import { RoutingSelectionService } from '../dist/domains/routing-context/selection/RoutingSelectionService.js';
import { enqueueA2ATargets } from '../dist/routes/callback-a2a-trigger.js';
import { registerCallbackAuthHook } from '../dist/routes/callback-auth-prehandler.js';
import { registerCallbackThreadCatsRoutes } from '../dist/routes/callback-thread-cats-routes.js';
import { accountCapacityFixture } from './helpers/account-routing-capacity-fixture.js';
import { routingJourneyDeps } from './helpers/routing-journey-deps.js';

test('HTTP discovery → durable admission → switched-account C → exact terminal with an expired restriction', async (t) => {
  const f = accountCapacityFixture(t);
  let now = f.now;
  const originalConfigs = catRegistry.getAllConfigs();
  const configs = {
    codex: {
      ...originalConfigs.codex,
      accountRef: 'main-private-ref',
      accountBindingMode: 'override',
      configurationSource: 'managed_account',
    },
    gpt52: {
      ...originalConfigs.gpt52,
      accountRef: 'spare-private-ref',
      accountBindingMode: 'override',
      configurationSource: 'managed_account',
    },
    kimi: { ...originalConfigs.kimi, accountRef: undefined },
  };
  for (const key of Object.keys(f.configs)) delete f.configs[key];
  Object.assign(f.configs, configs);
  catRegistry.reset();
  for (const [id, config] of Object.entries(configs)) catRegistry.register(id, config);
  t.after(() => {
    catRegistry.reset();
    for (const [id, config] of Object.entries(originalConfigs)) catRegistry.register(id, config);
  });
  const events = [];
  const resolver = new RoutingContextResolver({
    signalStore: {
      getOwnerRevision: async () => events.length,
      readDecisionProjection: async () =>
        buildRoutingSignalDecisionProjection({ ownerId: 'owner', revision: events.length, events }),
      listByOwner: async () => {
        throw new Error('A/B/C must not read the audit ledger');
      },
    },
    preferenceStore: { listByOwner: async () => [] },
    profileRevisionSource: { load: async () => ({ status: 'fresh', profiles: [] }) },
  });
  const readService = new RoutingContextReadService({ catalogSource: f.source, resolver });
  const selection = new RoutingSelectionService({ readService, now: () => now });
  const preflight = new RuntimeRoutingDispatchPreflight({
    catalogSource: f.source,
    preflightService: new RoutingPreflightService({ resolver }),
    now: () => now,
  });
  const app = Fastify();
  registerCallbackAuthHook(app, {
    verify: async (id, token) =>
      id === 'source' && token === 'token'
        ? { ok: true, record: { catId: 'kimi', userId: 'owner', threadId: 'journey', invocationId: id } }
        : { ok: false, reason: 'unknown_invocation' },
  });
  registerCallbackThreadCatsRoutes(app, {
    threadStore: {
      get: async () => ({ id: 'journey', createdBy: 'owner' }),
      getParticipantsWithActivity: async () => [],
    },
    agentRegistry: { getAllEntries: () => new Map(Object.keys(configs).map((id) => [id, {}])) },
    routingSelection: selection,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  t.after(() => app.close());
  const address = app.server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/callbacks/thread-cats?forRole=review`, {
    headers: { 'x-invocation-id': 'source', 'x-callback-token': 'token' },
  });
  assert.equal(response.status, 200);
  const a = (await response.json()).selection;
  assert.match(a.facts, /codex.*70%/);
  assert.match(a.facts, /gpt52.*100%/);
  // A controlled consumer chooses the fresh alternative it learned about at the real discovery entry.
  const target = a.facts.includes('gpt52: 备用号') ? 'gpt52' : 'codex';
  assert.equal(target, 'gpt52');
  const messageStore = new MessageStore();
  const queue = new InvocationQueue();
  const source = messageStore.append({
    from: { kind: 'agent', catId: 'kimi' },
    userId: 'owner',
    threadId: 'journey',
    content: 'Please review this task',
    mentions: [target],
    origin: 'callback',
    timestamp: now,
  });
  const b = await enqueueA2ATargets(
    {
      messageStore,
      invocationQueue: queue,
      routingDispatchPreflight: preflight,
      socketManager: { emitToUser() {}, broadcastAgentMessage() {} },
      log: { info() {}, warn() {}, error() {} },
    },
    {
      userId: 'owner',
      threadId: 'journey',
      callerCatId: 'kimi',
      triggerMessage: source,
      targetCats: [target],
      content: source.content,
      ownerAuthProvenance: 'unknown',
    },
  );
  assert.equal(b.routingAdmission.stage, 'queue_admitted');
  assert.equal(b.routingAdmission.executionPreflight, 'pending');
  assert.equal(b.routingAdmission.targets[0].disposition, undefined);
  const [entry] = queue.list('journey', 'owner');
  configs.gpt52.accountRef = 'main-private-ref';
  events.push({
    v: 1,
    eventId: 'pause',
    commandId: 'pause',
    ownerId: 'owner',
    subjectRef: { type: 'cat', catId: target },
    eventType: 'asserted',
    state: 'unavailable',
    source: 'manual_cvo',
    reasonCode: 'temporary_pause',
    observedAt: now + 1,
    validUntil: now + 2,
    evidenceRef: 'owner:pause-until',
  });
  now += 3;
  let consumed;
  const terminals = [];
  const provider = {
    async *invoke(_prompt, options) {
      consumed = options.executionAccount;
      yield { type: 'text', catId: target, content: '@co-creator\nAccepted the review task.', timestamp: Date.now() };
      yield { type: 'done', catId: target, timestamp: Date.now() };
    },
  };
  const { deps, messages } = routingJourneyDeps(
    preflight,
    { observeTerminal: async (evidence) => terminals.push(evidence) },
    provider,
  );
  deps.services = { [target]: provider };
  for await (const _event of routeSerial(deps, [target], source.content, 'owner', 'journey', {
    routingAdmission: entry.delivery.routingAdmission,
    currentUserMessageId: source.id,
  })) {
    /* real route/invocation boundary; provider is controlled */
  }
  assert.equal(terminals.length, 1);
  const c = terminals[0].preflightDecision;
  assert.equal(c.resolverState, 'fresh');
  assert.notEqual(c.snapshotRef, b.routingAdmission.snapshotRef);
  assert.equal(c.targets[0].targetCatId, target);
  assert.equal(c.targets[0].capacityFacts.current.windows[0].remainingPercent, 70);
  assert.equal(c.targets[0].capacityFacts.current.bindingRevision, consumed.accountRevision);
  assert.ok(c.targets[0].capacityFacts.current.windows.every((window) => window.applicability === 'unknown'));
  assert.ok(c.targets[0].reasons.some((reason) => reason.code === 'routing_capacity_unverified'));
  assert.equal(consumed.accountRef, 'main-private-ref');
  assert.equal(
    c.targets[0].disposition,
    'warned',
    'an expired manual restriction becomes unknown, not a permanent block',
  );
  assert.equal(
    messages.some((message) => message.extra?.systemInfo?.payload.type === 'routing_preflight'),
    false,
    'account changes and unknown applicability remain internal when the target still executes',
  );
  const child = await deps.invocationDeps.turnExecutionStore.get(terminals[0].observationId);
  assert.equal(child.status, 'succeeded');
  assert.equal(child.causal.routingPreflight.snapshotRef, c.snapshotRef);
  assert.equal(child.causal.routingPreflight.admission.snapshotRef, b.routingAdmission.snapshotRef);
  if (process.env.F293_DOGFOOD_OUTPUT)
    writeFileSync(
      process.env.F293_DOGFOOD_OUTPUT,
      JSON.stringify(
        {
          environment: 'feature worktree / isolated account fixture / ephemeral HTTP / controlled provider',
          liveAcceptance: false,
          A: a,
          B: b.routingAdmission,
          C: c,
          terminal: child,
          providerBindingMatched: true,
        },
        null,
        2,
      ) + '\n',
    );
});

test('an exact continuation race falls back to a new C without inventing B or overwriting the original child C', async (t) => {
  const f = accountCapacityFixture(t);
  const originalConfigs = catRegistry.getAllConfigs();
  const config = {
    ...originalConfigs.codex,
    accountRef: 'main-private-ref',
    accountBindingMode: 'override',
    configurationSource: 'managed_account',
  };
  catRegistry.reset();
  catRegistry.register('codex', config);
  t.after(() => {
    catRegistry.reset();
    for (const [id, value] of Object.entries(originalConfigs)) catRegistry.register(id, value);
  });
  for (const key of Object.keys(f.configs)) delete f.configs[key];
  f.configs.codex = config;
  let now = f.now;
  const resolver = new RoutingContextResolver({
    signalStore: {
      getOwnerRevision: async () => 0,
      readDecisionProjection: async () =>
        buildRoutingSignalDecisionProjection({ ownerId: 'owner', revision: 0, events: [] }),
      listByOwner: async () => {
        throw new Error('A/B/C must not read the audit ledger');
      },
    },
    preferenceStore: { listByOwner: async () => [] },
    profileRevisionSource: { load: async () => ({ status: 'fresh', profiles: [] }) },
  });
  const preflight = new RuntimeRoutingDispatchPreflight({
    catalogSource: f.source,
    preflightService: new RoutingPreflightService({ resolver }),
    now: () => now,
  });
  const terminals = [];
  let finishOriginal;
  let providerStarted;
  const started = new Promise((resolve) => {
    providerStarted = resolve;
  });
  const finish = new Promise((resolve) => {
    finishOriginal = resolve;
  });
  let calls = 0;
  const provider = {
    async *invoke() {
      if (++calls === 1) {
        providerStarted();
        await finish;
      }
      yield { type: 'done', catId: 'codex', timestamp: Date.now() };
    },
  };
  const { deps } = routingJourneyDeps(preflight, { observeTerminal: async (e) => terminals.push(e) }, provider);
  deps.services = { codex: provider };
  const originalRun = (async () => {
    for await (const _ of routeSerial(deps, ['codex'], 'Original work', 'owner', 'continuation-journey', {})) {
      /* drain */
    }
  })();
  t.after(finishOriginal);
  await started;
  const messageStore = new MessageStore();
  const queue = new InvocationQueue();
  const source = messageStore.append({
    from: { kind: 'agent', catId: 'kimi' },
    userId: 'owner',
    threadId: 'continuation-journey',
    content: 'Continue this exact active run',
    mentions: ['codex'],
    origin: 'callback',
    timestamp: now,
  });
  const admitted = await queue.enqueueExistingMessageDurable(messageStore, source.id, {
    from: source.from,
    userId: 'owner',
    ownerAuthProvenance: 'unknown',
    threadId: source.threadId,
    kind: 'message_wake',
    content: source.content,
    messageId: source.id,
    sourceId: source.id,
    sourceCategory: 'a2a',
    targetCats: ['codex'],
    intent: 'execute',
    autoExecute: true,
    authorIntentByCatId: { codex: { requested: 'continue_current', boundParentInvocationId: 'original-parent' } },
  });
  const b = await enqueueA2ATargets(
    {
      messageStore,
      invocationQueue: queue,
      routingDispatchPreflight: preflight,
      socketManager: { emitToUser() {}, broadcastAgentMessage() {} },
      log: { info() {}, warn() {}, error() {} },
    },
    {
      userId: 'owner',
      threadId: source.threadId,
      callerCatId: 'kimi',
      triggerMessage: source,
      targetCats: ['codex'],
      content: source.content,
      ownerAuthProvenance: 'unknown',
      preAdmittedEntries: [admitted.entry],
    },
  );
  assert.equal(b.routingAdmission, undefined);
  finishOriginal();
  await originalRun;
  const first = terminals[0];
  const originalChild = await deps.invocationDeps.turnExecutionStore.get(first.observationId);
  const originalC = structuredClone(originalChild.causal.routingPreflight);
  assert.equal(
    await queue.fallbackQueuedAuthorIntentDurable(
      source.threadId,
      'owner',
      admitted.entry.id,
      'codex',
      'no_active_parent',
    ),
    true,
  );
  const fallback = queue.getEntrySnapshot(source.threadId, 'owner', admitted.entry.id);
  assert.equal(fallback.delivery.routingAdmission, undefined);
  f.accounts['main-private-ref'].quota.items[0].usedPercent = 40;
  f.save();
  now++;
  for await (const _ of routeSerial(deps, ['codex'], source.content, 'owner', source.threadId, {
    currentUserMessageId: source.id,
    routingAdmission: fallback.delivery.routingAdmission,
  })) {
    /* actual new child execution */
  }
  assert.equal(terminals.length, 2);
  const nextC = terminals[1].preflightDecision;
  assert.equal(nextC.resolverState, 'fresh');
  assert.notEqual(nextC.snapshotRef, first.preflightDecision.snapshotRef);
  assert.equal(nextC.targets[0].capacityFacts.current.windows[0].remainingPercent, 60);
  const nextChild = await deps.invocationDeps.turnExecutionStore.get(terminals[1].observationId);
  assert.equal(nextChild.causal.routingPreflight.admission, undefined, 'a later fallback cannot invent B');
  assert.equal(nextChild.causal.routingPreflight.snapshotRef, nextC.snapshotRef);
  assert.deepEqual(
    (await deps.invocationDeps.turnExecutionStore.get(first.observationId)).causal.routingPreflight,
    originalC,
  );
});
