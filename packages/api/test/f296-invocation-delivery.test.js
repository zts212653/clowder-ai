import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { invokeSingleCat } from '../dist/domains/cats/services/agents/invocation/invoke-single-cat.js';
import { promptGenerationId } from '../dist/domains/cats/services/agents/invocation/provider-presentation-delivery.js';
import { ContextEpochOwner } from '../dist/domains/cats/services/session/ContextEpochOwner.js';
import {
  InMemoryPresentationLedgerStore,
  PresentationLedger,
} from '../dist/domains/cats/services/session/PresentationLedger.js';
import { InMemoryContextEpochStore } from '../dist/domains/cats/services/stores/ports/ContextEpochStore.js';
import { memoryCueOpportunityId } from '../dist/domains/memory/cue/MemoryCueInvocationPromptService.js';

const CODEX_EXEC = {
  provider: 'openai',
  carrier: 'exec_json',
  reportsRuntimeWindow: true,
  authoritativeUsage: true,
  usageTelemetry: 'available',
  nativeWindowControl: true,
  nativeCompressionControl: true,
  observesCompression: true,
  reason: 'fixture',
};

async function collect(iterable) {
  const messages = [];
  for await (const message of iterable) messages.push(message);
  return messages;
}

function makeDeps(overrides = {}) {
  return {
    registry: {
      create: async () => ({ invocationId: 'inv-f296', callbackToken: 'token-f296' }),
      verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
    },
    sessionManager: {
      get: async () => undefined,
      store: async () => {},
      delete: async () => {},
      resolveWorkingDirectory: () => '/tmp/test',
    },
    threadStore: null,
    apiUrl: 'http://127.0.0.1:3004',
    contextEpochOwner: new ContextEpochOwner(new InMemoryContextEpochStore()),
    presentationLedger: new PresentationLedger(new InMemoryPresentationLedgerStore()),
    ...overrides,
  };
}

function cueResolution(generation, invocationId = 'inv-f296') {
  const cueId = `cue-${generation}`;
  const opportunityId = `opportunity-${generation}`;
  const promptSegment = `<memory-cue v="1" cue-id="${cueId}">generation ${generation}</memory-cue>`;
  const deliveryReceipt = {
    cueId,
    event: {
      cueId,
      opportunityId,
      scope: { ownerUserId: 'owner-1', threadId: 'thread-f296', invocationId },
      resolverFamily: 'project_knowledge',
      sourceAnchor: 'feature:F296',
      sourceRevision: `revision-${generation}`,
      axis: 'consumption',
      consumptionOutcome: 'presented',
      catalogVersion: 1,
      resolverVersion: 1,
      occurredAt: generation,
    },
  };
  return {
    promptSegment,
    admittedOpportunityIds: [opportunityId],
    omittedOpportunityIds: [],
    deliveryReceipts: [deliveryReceipt],
    presentationEnvelopes: [
      {
        candidate: {
          subjectKey: deliveryReceipt.event.sourceAnchor,
          asOf: { kind: 'version', value: deliveryReceipt.event.sourceRevision },
          sourceTier: 'T2',
          requested: 'pointer',
          epistemicCeiling: 'pointer',
        },
        segments: { pointer: promptSegment },
        admission: {
          opportunityId,
          opportunityKind: 'recall',
          producerOwner: 'project_knowledge',
          consumerScope: {
            kind: 'invocation',
            ownerUserId: 'owner-1',
            threadId: 'thread-f296',
            invocationId,
          },
          entryVersion: 'test-recall:1',
          subjectKey: deliveryReceipt.event.sourceAnchor,
          asOf: { kind: 'version', value: deliveryReceipt.event.sourceRevision },
          sourceRefs: [deliveryReceipt.event.sourceAnchor],
          eligibleSurfaces: ['dynamic_context', 'pointer'],
          presentationPolicyRef: 'F296.OpportunityPresentation',
          tokenBudget: 300,
          dedupeKey: opportunityId,
          expiresAt: Date.now() + 60_000,
          invalidators: [{ owner: 'project_knowledge', ref: 'source_corrected' }],
          epistemicCeiling: 'pointer',
        },
        receipt: deliveryReceipt,
      },
    ],
  };
}

function fixedEpochOwner(contextEpoch = 7) {
  return {
    resolve: async ({ disposition }) => ({
      scopeKey: 'owner-1::codex::thread-f296',
      contextEpoch,
      contextMode: 'cold',
      lastTransitionRef: 'fixture:fixed-epoch',
      consumedCompactionEventIds: [],
      transition: 'fresh',
      normalizedDisposition: disposition,
      healthSignals: [],
    }),
  };
}

function observingLedger() {
  const actual = new PresentationLedger(new InMemoryPresentationLedgerStore(), {
    now: () => 1_000_000,
    newToken: (() => {
      let next = 0;
      return () => `reservation-${++next}`;
    })(),
  });
  const calls = [];
  return {
    calls,
    ledger: {
      reserve: async (...args) => {
        const outcome = await actual.reserve(...args);
        calls.push({ kind: 'reserve', outcome });
        return outcome;
      },
      commit: async (...args) => {
        const outcome = await actual.commit(...args);
        calls.push({ kind: 'commit', outcome });
        return outcome;
      },
      release: async (...args) => {
        await actual.release(...args);
        calls.push({ kind: 'release', reservation: args[0], reason: args[1] });
      },
    },
  };
}

function parseSystemInfo(messages, type) {
  return messages.flatMap((message) => {
    if (message.type !== 'system_info' || !message.content) return [];
    try {
      const parsed = JSON.parse(message.content);
      return parsed.type === type ? [parsed] : [];
    } catch {
      return [];
    }
  });
}

describe('F296 B0 provider-start handshake and delivery receipts', () => {
  it('fails before provider start when a requested Codex session has no cold rebuild path', async () => {
    let providerStarted = false;
    const service = {
      contextCapability: () => CODEX_EXEC,
      async *invoke() {
        providerStarted = true;
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
      },
    };
    const deps = makeDeps({
      sessionManager: {
        get: async () => 'unverified-runtime-session',
        store: async () => {},
        delete: async () => {},
        resolveWorkingDirectory: () => '/tmp/test',
      },
    });

    const messages = await collect(
      invokeSingleCat(deps, {
        catId: 'codex',
        service,
        prompt: 'possibly-hot prompt',
        userId: 'owner-1',
        ownerAuthProvenance: 'unknown',
        threadId: 'thread-f296',
        invocationOrigin: 'interactive',
        routeTopology: 'serial',
        isLastCat: true,
      }),
    );
    assert.ok(
      messages.some(
        (message) =>
          message.type === 'error' && String(message.error).includes('context_continuity_cold_rebuild_unavailable'),
      ),
    );
    assert.equal(providerStarted, false);
  });

  it('emits the Codex handshake before provider output and records presentation only at delivery', async () => {
    const timeline = [];
    const confirmations = [];
    const memoryCuePromptService = {
      resolve: async () => ({ ...cueResolution(1), omittedOpportunityIds: ['opportunity-omitted'] }),
      recordPresented: async (receipts, confirmation) => {
        timeline.push('record-presented');
        confirmations.push({ receipts, confirmation });
      },
    };
    const service = {
      contextCapability: () => CODEX_EXEC,
      async *invoke(prompt) {
        timeline.push('provider-start');
        assert.match(prompt, /cue-id="cue-1"/);
        assert.equal(confirmations.length, 0, 'rendering and provider start are not delivery proof');
        yield { type: 'text', catId: 'codex', content: 'delivered', timestamp: Date.now() };
        timeline.push('provider-after-text');
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
      },
    };

    const messages = await collect(
      invokeSingleCat(makeDeps({ memoryCuePromptService }), {
        catId: 'codex',
        service,
        prompt: 'base prompt',
        userId: 'owner-1',
        ownerAuthProvenance: 'unknown',
        threadId: 'thread-f296',
        invocationOrigin: 'interactive',
        routeTopology: 'serial',
        memoryCueOpportunitySeeds: [{ kind: 'subject_seen', producer: 'entity_nudge', occurredAt: 1, payload: {} }],
        isLastCat: true,
      }),
    );

    const handshakes = parseSystemInfo(messages, 'context_continuity');
    assert.equal(handshakes.length, 1);
    assert.equal(handshakes[0].disposition.state, 'fresh');
    assert.equal(handshakes[0].contextMode, 'cold');
    const receipts = parseSystemInfo(messages, 'context_presentation_receipt');
    assert.deepEqual(
      receipts.map((receipt) => receipt.outcome),
      ['presented', 'omitted'],
    );
    assert.deepEqual(receipts[0].projectionIds, ['cue-1']);
    assert.deepEqual(receipts[1].opportunityIds, ['opportunity-omitted']);
    assert.equal(confirmations.length, 1);
    assert.equal(confirmations[0].confirmation.generationId, receipts[0].generationId);
    assert.ok(timeline.indexOf('record-presented') < timeline.indexOf('provider-after-text'));
    assert.ok(
      messages.findIndex((message) => message.content?.includes('"type":"context_continuity"')) <
        messages.findIndex((message) => message.type === 'text' && message.content === 'delivered'),
    );
  });

  it('does not let an untyped legacy fallback bypass mapper and ledger admission', async () => {
    const seed = { kind: 'subject_seen', producer: 'entity_nudge', occurredAt: 1, payload: {} };
    const fallbackText = 'legacy subject fallback reached the provider';
    const memoryCuePromptService = {
      resolve: async ({ seeds, serverScope }) => ({
        promptSegment: '',
        admittedOpportunityIds: [],
        omittedOpportunityIds: [memoryCueOpportunityId(seeds[0], serverScope)],
        deliveryReceipts: [],
      }),
    };
    let providerPrompt = '';
    const service = {
      contextCapability: () => CODEX_EXEC,
      async *invoke(prompt) {
        providerPrompt = prompt;
        yield { type: 'text', catId: 'codex', content: 'delivered', timestamp: Date.now() };
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
      },
    };

    const messages = await collect(
      invokeSingleCat(makeDeps({ memoryCuePromptService }), {
        catId: 'codex',
        service,
        prompt: 'base prompt',
        userId: 'owner-1',
        ownerAuthProvenance: 'unknown',
        threadId: 'thread-f296',
        invocationOrigin: 'interactive',
        routeTopology: 'serial',
        memoryCueOpportunitySeeds: [seed],
        memoryCueLegacyFallbacks: [{ seed, promptContext: fallbackText }],
        isLastCat: true,
      }),
    );

    assert.doesNotMatch(providerPrompt, new RegExp(fallbackText));
    const receipts = parseSystemInfo(messages, 'context_presentation_receipt');
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].outcome, 'omitted');
    assert.deepEqual(receipts[0].opportunityIds, [
      memoryCueOpportunityId(seed, {
        ownerUserId: 'owner-1',
        threadId: 'thread-f296',
        invocationId: 'inv-f296',
      }),
    ]);
  });

  it('binds presented to the rebuilt prompt generation after stale-session self-heal', async () => {
    const { ledger, calls } = observingLedger();
    let cueGeneration = 0;
    let rebuildGeneration = 0;
    let invokeCount = 0;
    const providerPrompts = [];
    const confirmations = [];
    const memoryCuePromptService = {
      resolve: async () => cueResolution(++cueGeneration),
      recordPresented: async (receipts, confirmation) => confirmations.push({ receipts, confirmation }),
    };
    const service = {
      contextCapability: () => CODEX_EXEC,
      async *invoke(prompt) {
        providerPrompts.push(prompt);
        invokeCount += 1;
        if (invokeCount === 1) {
          yield {
            type: 'error',
            catId: 'codex',
            error: 'No conversation found with session ID: stale-runtime-session',
            timestamp: Date.now(),
          };
          yield { type: 'done', catId: 'codex', timestamp: Date.now() };
          return;
        }
        yield { type: 'text', catId: 'codex', content: 'recovered', timestamp: Date.now() };
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
      },
    };
    const deps = makeDeps({
      memoryCuePromptService,
      presentationLedger: ledger,
      sessionManager: {
        get: async () => 'stale-runtime-session',
        store: async () => {},
        delete: async () => {},
        resolveWorkingDirectory: () => '/tmp/test',
      },
    });

    const messages = await collect(
      invokeSingleCat(deps, {
        catId: 'codex',
        service,
        prompt: 'possibly-hot prompt',
        rebuildPromptAfterSessionSeal: async () => `cold rebuild ${++rebuildGeneration}`,
        userId: 'owner-1',
        ownerAuthProvenance: 'unknown',
        threadId: 'thread-f296',
        invocationOrigin: 'interactive',
        routeTopology: 'serial',
        memoryCueOpportunitySeeds: [{ kind: 'subject_seen', producer: 'entity_nudge', occurredAt: 1, payload: {} }],
        isLastCat: true,
      }),
    );

    assert.equal(providerPrompts.length, 2);
    assert.match(providerPrompts[0], /cold rebuild 1/);
    assert.match(providerPrompts[0], /cue-id="cue-1"/);
    assert.match(providerPrompts[1], /cold rebuild 2/);
    assert.match(providerPrompts[1], /cue-id="cue-2"/);
    assert.doesNotMatch(providerPrompts[1], /cue-id="cue-1"/);
    assert.equal(confirmations.length, 1, 'failed prompt generation must never be marked presented');
    assert.deepEqual(
      confirmations[0].receipts.map((receipt) => receipt.cueId),
      ['cue-2'],
    );
    const receipts = parseSystemInfo(messages, 'context_presentation_receipt');
    assert.deepEqual(
      receipts.flatMap((receipt) => receipt.projectionIds ?? []),
      ['cue-2'],
    );
    const handshakes = parseSystemInfo(messages, 'context_continuity');
    assert.deepEqual(
      handshakes.map(({ disposition }) => [disposition.state, disposition.reason]),
      [
        ['unknown', 'signal_unavailable'],
        ['fresh', 'resume_failed'],
      ],
    );
    assert.deepEqual(
      handshakes.map(({ contextEpoch, contextMode, transition }) => [contextEpoch, contextMode, transition]),
      [
        [1, 'cold', 'scope_first_seen'],
        [2, 'cold', 'fresh'],
      ],
      'stale-session self-heal must resolve a new cold epoch before the replacement provider generation',
    );
    assert.deepEqual(
      calls.map(({ kind }) => kind),
      ['reserve', 'release', 'reserve', 'commit'],
    );
    assert.equal(calls[0].outcome.reservation.promptGenerationId, promptGenerationId(providerPrompts[0]));
    assert.equal(calls[1].reason, 'provider_generation_replaced');
    assert.equal(calls[2].outcome.reservation.promptGenerationId, promptGenerationId(providerPrompts[1]));
    assert.equal(calls[3].outcome.committed, true);
  });

  it('admits a real prompt projection once per shared epoch and binds its receipt to the exact provider prompt', async () => {
    const { ledger, calls } = observingLedger();
    const confirmations = [];
    const providerPrompts = [];
    let invocationSequence = 0;
    const memoryCuePromptService = {
      resolve: async ({ serverScope }) => cueResolution(1, serverScope.invocationId),
      recordPresented: async (receipts, confirmation) => confirmations.push({ receipts, confirmation }),
    };
    const service = {
      contextCapability: () => CODEX_EXEC,
      async *invoke(prompt) {
        providerPrompts.push(prompt);
        yield { type: 'text', catId: 'codex', content: 'delivered', timestamp: Date.now() };
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
      },
    };
    const deps = makeDeps({
      contextEpochOwner: fixedEpochOwner(),
      presentationLedger: ledger,
      memoryCuePromptService,
      registry: {
        create: async () => ({ invocationId: `inv-f296-${++invocationSequence}`, callbackToken: 'token-f296' }),
        verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
      },
    });
    const params = {
      catId: 'codex',
      service,
      prompt: 'base prompt',
      userId: 'owner-1',
      ownerAuthProvenance: 'unknown',
      threadId: 'thread-f296',
      invocationOrigin: 'interactive',
      routeTopology: 'serial',
      memoryCueOpportunitySeeds: [{ kind: 'subject_seen', producer: 'entity_nudge', occurredAt: 1, payload: {} }],
      isLastCat: true,
    };

    await collect(invokeSingleCat(deps, params));
    await collect(invokeSingleCat(deps, params));

    assert.match(providerPrompts[0], /cue-id="cue-1"/);
    assert.doesNotMatch(providerPrompts[1], /cue-id="cue-1"/);
    assert.equal(confirmations.length, 1);
    assert.equal(
      confirmations[0].confirmation.generationId,
      `sha256:${createHash('sha256').update(providerPrompts[0]).digest('hex')}`,
      'receipt generation must name the exact bytes accepted by the provider',
    );
    assert.deepEqual(
      calls.map(({ kind }) => kind),
      ['reserve', 'commit', 'reserve'],
    );
    assert.equal(calls[2].outcome.admitted, false);
    assert.equal(calls[2].outcome.reason, 'already_delivered_this_epoch');
  });

  it('releases an unconfirmed reservation before a same-epoch provider retry', async () => {
    const { ledger, calls } = observingLedger();
    const providerPrompts = [];
    const confirmations = [];
    const memoryCuePromptService = {
      resolve: async () => cueResolution(1),
      recordPresented: async (receipts, confirmation) => confirmations.push({ receipts, confirmation }),
    };
    let attempt = 0;
    const service = {
      contextCapability: () => CODEX_EXEC,
      async *invoke(prompt) {
        providerPrompts.push(prompt);
        attempt += 1;
        if (attempt === 1) {
          yield {
            type: 'error',
            catId: 'codex',
            error: 'Codex CLI: CLI 异常退出 (code: 1, signal: none)',
            timestamp: Date.now(),
          };
          yield { type: 'done', catId: 'codex', timestamp: Date.now() };
          return;
        }
        yield { type: 'text', catId: 'codex', content: 'recovered', timestamp: Date.now() };
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
      },
    };

    await collect(
      invokeSingleCat(
        makeDeps({ contextEpochOwner: fixedEpochOwner(), presentationLedger: ledger, memoryCuePromptService }),
        {
          catId: 'codex',
          service,
          prompt: 'base prompt',
          userId: 'owner-1',
          ownerAuthProvenance: 'unknown',
          threadId: 'thread-f296',
          invocationOrigin: 'interactive',
          routeTopology: 'serial',
          memoryCueOpportunitySeeds: [{ kind: 'subject_seen', producer: 'entity_nudge', occurredAt: 1, payload: {} }],
          isLastCat: true,
        },
      ),
    );

    assert.equal(providerPrompts.length, 2);
    assert.match(providerPrompts[0], /cue-id="cue-1"/);
    assert.match(providerPrompts[1], /cue-id="cue-1"/);
    assert.equal(confirmations.length, 1);
    assert.deepEqual(
      calls.map(({ kind }) => kind),
      ['reserve', 'release', 'reserve', 'commit'],
    );
  });
});
