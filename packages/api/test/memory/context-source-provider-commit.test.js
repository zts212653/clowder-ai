import '../helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { invokeSingleCat } from '../../dist/domains/cats/services/agents/invocation/invoke-single-cat.js';
import { ContextEpochOwner } from '../../dist/domains/cats/services/session/context/ContextEpochOwner.js';
import {
  InMemoryPresentationLedgerStore,
  PresentationLedger,
} from '../../dist/domains/cats/services/session/context/PresentationLedger.js';
import { InMemoryContextEpochStore } from '../../dist/domains/cats/services/stores/ports/ContextEpochStore.js';
import { ContextSourceAdmission } from '../../dist/domains/memory/cue/ContextSourceAdmission.js';
import { ContextSourceOpportunityStore } from '../../dist/domains/memory/cue/ContextSourceOpportunityStore.js';
import { createMemoryCueRuntime } from '../../dist/domains/memory/cue/createMemoryCueRuntime.js';
import { MemoryCueEpisodeStore } from '../../dist/domains/memory/cue/MemoryCueEpisodeStore.js';
import { memoryCueOpportunityId } from '../../dist/domains/memory/cue/MemoryCueInvocationPromptService.js';
import { applyMigrations } from '../../dist/domains/memory/schema.js';

function envelope(scope, opportunityId, source, entry, size = 40, valid = true) {
  const subjectKey = `memory-cue:project_knowledge:${source}:consumer:codex`;
  const asOf = { kind: 'version', value: 'v1' };
  const segment = `${source} ${'token '.repeat(size)}`;
  return {
    candidate: { subjectKey, asOf, sourceTier: 'T2', requested: 'pointer', epistemicCeiling: 'pointer' },
    admission: {
      opportunityId,
      opportunityKind: 'recall',
      producerOwner: 'context_epoch',
      consumerScope: { kind: 'invocation', ...scope },
      entryVersion: `recall-catalog:7:${entry}:context_epoch`,
      subjectKey,
      asOf,
      sourceRefs: [source],
      eligibleSurfaces: ['dynamic_context'],
      presentationPolicyRef: 'F296.OpportunityPresentation',
      tokenBudget: entry === 'fresh_context_sources' ? 900 : 6000,
      dedupeKey: source,
      expiresAt: Date.now() + 300000,
      invalidators: [{ owner: 'source', ref: source }],
      epistemicCeiling: 'pointer',
    },
    segments: { pointer: segment },
    validateCurrent: async () => valid,
    receipt: {
      cueId: source,
      event: {
        cueId: source,
        opportunityId,
        scope,
        consumerCatId: 'codex',
        resolverFamily: 'project_knowledge',
        sourceAnchor: source,
        sourceRevision: 'v1',
        axis: 'consumption',
        consumptionOutcome: 'presented',
        catalogVersion: 7,
        resolverVersion: 1,
        occurredAt: Date.now(),
      },
    },
  };
}

function scenarioEnvelopes(scenario, scope, id) {
  const old = (source, size) => envelope(scope, 'old-opportunity', source, 'project_source_required', size);
  const current = (source, size, valid) => envelope(scope, id, source, 'fresh_context_sources', size, valid);
  switch (scenario) {
    case 'empty':
      return [];
    case 'source-cap':
      return [...Array.from({ length: 6 }, (_, i) => old(`old-${i}`)), current('context-pointer')];
    case 'token-cap':
      return [old('old-a', 2800), old('old-b', 2800), current('context-pointer', 600)];
    case 'partial-commit':
      return [current('context-pointer', 40), current('rejected-pointer', 40)];
    case 'partial':
      return [current('context-pointer', 600), current('omitted-pointer', 600)];
    default:
      return [current('context-pointer', 40, scenario !== 'invalid')];
  }
}

for (const scenario of [
  'source-cap',
  'token-cap',
  'partial',
  'partial-commit',
  'empty',
  'invalid',
  'provider-failure',
  'ledger-rejected',
  'reservation_superseded',
  'context_epoch_retired',
]) {
  test(`${scenario}: only delivered context pointers consume the original opportunity`, async (t) => {
    const db = new Database(':memory:');
    t.after(() => db.close());
    applyMigrations(db);
    const store = new ContextSourceOpportunityStore(db);
    const admission = new ContextSourceAdmission({
      store,
      messages: {
        getById: async () => ({ id: 'source', userId: 'owner', threadId: 'thread', catId: null, content: 'task' }),
      },
      threads: { get: async () => ({ id: 'thread', createdBy: 'owner', projectPath: '/project' }) },
      tasks: { get: async () => null, listByThread: async () => [] },
    });
    let preparedInput;
    const commitWrites = [];
    const mark = store.markProviderCommitted.bind(store);
    store.markProviderCommitted = (id, generation) => {
      commitWrites.push(id);
      return mark(id, generation);
    };
    const episodes = new MemoryCueEpisodeStore(db);
    const epochStore = new InMemoryContextEpochStore();
    const epochOwner = new ContextEpochOwner(epochStore);
    const ledgerStore = new InMemoryPresentationLedgerStore(epochStore);
    const reservations = [];
    const ledger = new PresentationLedger(ledgerStore);
    const reserve = ledger.reserve.bind(ledger);
    ledger.reserve = async (...args) => {
      const result = await reserve(...args);
      if (result.admitted) reservations.push(result.reservation);
      return result;
    };
    const output = [];
    const prompts = [];
    const service = {
      contextCapability: () => ({
        provider: 'openai',
        carrier: 'app_server',
        reportsRuntimeWindow: true,
        authoritativeUsage: true,
        usageTelemetry: 'available',
        nativeWindowControl: true,
        nativeCompressionControl: true,
        observesCompression: true,
        reason: 'fixture',
      }),
      async *invokeWithContinuityPreflight(preflight, options) {
        const settled = await preflight.settle({ evidence: { kind: 'started', runtimeSessionId: 'runtime' } });
        await options.beforeProviderLaunch({
          v: 1,
          message: { body: settled.prompt },
          nativeInstructions: [],
          runtime: { provider: 'openai', carrier: 'app_server' },
          tools: { finalSurface: 'unknown' },
          providerNativeVisibility: 'unknown',
        });
        prompts.push(settled.prompt);
        if (scenario === 'reservation_superseded')
          for (const reservation of reservations) await ledger.release(reservation, 'competing generation');
        if (scenario === 'partial-commit') await ledger.release(reservations[1], 'competing generation');
        if (scenario === 'context_epoch_retired')
          await epochOwner.observeCompaction({
            userId: 'owner',
            catId: 'codex',
            threadId: 'thread',
            event: { eventId: 'compact', evidenceRef: 'provider-compact', runtimeSessionId: 'runtime' },
          });
        if (scenario === 'provider-failure') {
          yield { type: 'error', catId: 'codex', error: 'provider unavailable', timestamp: Date.now() };
        } else {
          yield { type: 'text', catId: 'codex', content: 'answer', timestamp: Date.now() };
          yield { type: 'done', catId: 'codex', timestamp: Date.now() };
        }
      },
    };
    if (scenario === 'ledger-rejected')
      ledger.commit = async () => ({ committed: false, reason: 'generation_mismatch' });
    const deps = {
      registry: {
        create: async () => ({ invocationId: 'invocation', callbackToken: 'token' }),
        verify: async () => ({ ok: false }),
      },
      sessionManager: {
        get: async () => undefined,
        store: async () => {},
        delete: async () => {},
        resolveWorkingDirectory: () => '/tmp/test',
      },
      threadStore: null,
      apiUrl: 'http://127.0.0.1:3004',
      contextEpochOwner: epochOwner,
      presentationLedger: ledger,
      contextSourceAdmission: {
        prepare: async (input) => {
          preparedInput = input;
          return admission.prepare(input);
        },
      },
    };
    const runtime = createMemoryCueRuntime({
      ownerUserId: 'owner',
      contextSourceOpportunityStore: store,
      episodeStore: episodes,
      messageStore: { getById: async () => null },
      handles: { issue: () => 'unused' },
      evidenceStore: { getByAnchor: () => null },
      eventStore: {},
      entityRegistry: {},
      tasteRepository: {},
      profileRepository: {},
      projectDocsRoot: '/tmp/test',
      autoDreamStore: {},
    });
    runtime.promptService.resolve = async (input) => {
      const seed = input.seeds.find((s) => s.kind === 'fresh_context_sources');
      assert.ok(seed, 'the actual provider preflight must prepare the trusted opportunity');
      const id = memoryCueOpportunityId(seed, input.serverScope, input.consumerCatId);
      const envelopes = scenarioEnvelopes(scenario, input.serverScope, id);
      return {
        promptSegment: envelopes.length ? 'resolved' : '',
        admittedOpportunityIds: envelopes.length ? [id] : [],
        omittedOpportunityIds: envelopes.length ? [] : [id],
        deliveryReceipts: [],
        presentationEnvelopes: envelopes,
      };
    };
    deps.memoryCuePromptService = runtime.promptService;
    for await (const message of invokeSingleCat(deps, {
      catId: 'codex',
      service,
      prompt: 'task',
      userId: 'owner',
      threadId: 'thread',
      ownerAuthProvenance: 'strict',
      invocationOrigin: 'interactive',
      routeTopology: 'serial',
      isLastCat: true,
      executionCausal: { triggerMessageId: 'source' },
      contextSourceIngress: { kind: 'owner', sourceMessageId: 'source' },
      contextPromptFactory: async () => ({ prompt: 'task', promptMessageIds: ['source'] }),
    })) {
      output.push(message);
    }
    assert.equal(prompts.length, 1, 'the actual final provider generation ran');
    const record = store.find('owner::codex::thread', 1, 'source', 'codex');
    assert.ok(record);
    assert.equal(
      prompts[0].includes('context-pointer'),
      [
        'partial',
        'partial-commit',
        'provider-failure',
        'ledger-rejected',
        'reservation_superseded',
        'context_epoch_retired',
      ].includes(scenario),
    );
    assert.ok(!prompts[0].includes('omitted-pointer'));
    const delivered = scenario === 'partial' || scenario === 'partial-commit';
    assert.equal(record.committed, delivered, 'withheld or unreceived pointers must not consume the opportunity');
    assert.deepEqual(
      commitWrites.filter((id) => id === record.opportunityId),
      delivered ? [record.opportunityId] : [],
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM memory_cue_context_opportunities').get().count, 1);
    const presented = episodes
      .listByInvocation('owner', 'thread', 'invocation')
      .filter((e) => e.opportunityId === record.opportunityId);
    assert.deepEqual(
      presented.map((e) => e.cueId),
      delivered ? ['context-pointer'] : [],
    );
    const visible = output
      .filter((m) => m.content?.includes('context_presentation_receipt'))
      .map((m) => JSON.parse(m.content));
    assert.equal(
      visible.some((r) => r.outcome === 'presented' && r.projectionIds.includes('context-pointer')),
      delivered,
    );
    if (scenario === 'partial-commit')
      assert.ok(
        visible.some(
          (r) =>
            r.outcome === 'omitted' &&
            r.rejections.some((e) => e.projectionId === 'rejected-pointer' && e.reason === 'reservation_superseded'),
        ),
      );
    if (['reservation_superseded', 'context_epoch_retired'].includes(scenario)) {
      assert.ok(visible.some((r) => r.outcome === 'omitted' && r.opportunityIds.includes(record.opportunityId)));
      const reservation = reservations[0];
      const retryReserve = await ledgerStore.reserve(reservation.address, {
        token: 'retry',
        nowMs: Date.now(),
        expiresAtMs: Date.now() + 1000,
        promptGenerationId: 'retry',
      });
      assert.equal(retryReserve, scenario === 'context_epoch_retired' ? 'context_epoch_retired' : 'reserved');
    }
    const retry = await admission.prepare({
      ...preparedInput,
      signal: undefined,
      now: Date.now(),
      decision: {
        ...preparedInput.decision,
        transition: 'resumed',
        normalizedDisposition: {
          state: 'resumed',
          reason: 'resume_confirmed',
          evidenceRef: 'retry',
          runtimeSessionId: 'runtime',
        },
      },
    });
    assert.equal(
      retry ? memoryCueOpportunityId(retry, preparedInput.scope, 'codex') : null,
      delivered ? null : record.opportunityId,
    );
  });
}
