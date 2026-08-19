import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { invokeSingleCat } from '../dist/domains/cats/services/agents/invocation/invoke-single-cat.js';
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
    ...overrides,
  };
}

function cueResolution(generation) {
  const cueId = `cue-${generation}`;
  const opportunityId = `opportunity-${generation}`;
  return {
    promptSegment: `<memory-cue v="1" cue-id="${cueId}">generation ${generation}</memory-cue>`,
    admittedOpportunityIds: [opportunityId],
    omittedOpportunityIds: [],
    deliveryReceipts: [
      {
        cueId,
        projectionMarker: `cue-id="${cueId}"`,
        event: {
          cueId,
          opportunityId,
          scope: { ownerUserId: 'owner-1', threadId: 'thread-f296', invocationId: 'inv-f296' },
          resolverFamily: 'project_knowledge',
          sourceAnchor: 'feature:F296',
          sourceRevision: `revision-${generation}`,
          axis: 'consumption',
          consumptionOutcome: 'presented',
          catalogVersion: 1,
          resolverVersion: 1,
          occurredAt: generation,
        },
      },
    ],
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

  it('does not report omitted when the matching legacy fallback enters the final prompt', async () => {
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
    const service = {
      contextCapability: () => CODEX_EXEC,
      async *invoke(prompt) {
        assert.match(prompt, new RegExp(fallbackText));
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

    assert.deepEqual(parseSystemInfo(messages, 'context_presentation_receipt'), []);
  });

  it('binds presented to the rebuilt prompt generation after stale-session self-heal', async () => {
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
  });
});
