import '../helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { resolveContextContinuity } from '../../dist/domains/cats/services/agents/invocation/context-continuity.js';
import { invokeSingleCat } from '../../dist/domains/cats/services/agents/invocation/invoke-single-cat.js';
import { ContextEpochOwner } from '../../dist/domains/cats/services/session/ContextEpochOwner.js';
import {
  InMemoryPresentationLedgerStore,
  PresentationLedger,
} from '../../dist/domains/cats/services/session/PresentationLedger.js';
import { InMemoryContextEpochStore } from '../../dist/domains/cats/services/stores/ports/ContextEpochStore.js';
import { MemoryContractTrialTraceBuffer } from '../../dist/domains/memory/people/AsrPersonMemoryContractTrial.js';
import { AsrPersonMemoryOpportunityPromptService } from '../../dist/domains/memory/people/AsrPersonMemoryOpportunityPromptService.js';
import { estimateTokens } from '../../dist/utils/token-counter.js';
import { artifact, intake } from './asr-person-memory-contract-fixture.js';

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

async function sceneAt(now) {
  const { buildAsrPersonMemoryDynamicScenes } = await import(
    '../../dist/domains/signal-intake/AsrPersonMemorySceneBuilder.js'
  );
  return buildAsrPersonMemoryDynamicScenes({
    intake: { ...intake, updatedAt: now - 10 },
    artifact,
    threadId: 'thread-1',
    consumerCatId: 'codex',
    now,
  })[0];
}

function handshake() {
  return resolveContextContinuity({
    capability: CODEX_EXEC,
    invocationId: 'inv-asr-f276',
    invocationOrigin: 'interactive',
    routeTopology: 'serial',
  });
}

function boundScene(scene, overrides = {}) {
  return {
    scene,
    source: {
      kind: 'message',
      threadId: 'thread-1',
      sourceMessageId: 'message-meeting-1',
      authorUserId: 'owner-1',
      authorRole: 'owner',
      visibility: 'verified_live_owner_message',
      ...overrides,
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

function dispositionAuthority() {
  return {
    writeOpportunityTerminalLedger: {
      async recordTerminal() {},
      async recordInvalidated() {},
      async readLineageStates(_ownerUserId, dedupeLineages) {
        return new Map(dedupeLineages.map((dedupeLineage) => [dedupeLineage, { terminalGenerations: new Map() }]));
      },
    },
    writeOpportunityDeliveryStore: {
      async recordDelivered() {},
      async get() {
        return null;
      },
      async listInvocationOpportunityIds() {
        return [];
      },
      async purgeLineage() {
        return 0;
      },
    },
  };
}

function presentationLedger() {
  return new PresentationLedger(new InMemoryPresentationLedgerStore());
}

describe('ASR → F276 F296 adapter', () => {
  it('admits a scoped mechanical observation into a bounded judgment prompt', async () => {
    const now = Date.now();
    const scene = await sceneAt(now);
    const trace = new MemoryContractTrialTraceBuffer();
    const service = new AsrPersonMemoryOpportunityPromptService({ trace });
    const resolution = service.resolve({
      candidates: [boundScene(scene)],
      serverScope: { ownerUserId: 'owner-1', threadId: 'thread-1', consumerCatId: 'codex' },
      continuity: handshake(),
      now,
      terminalGenerationKeys: new Set(),
    });

    assert.equal(resolution.deliveryReceipts.length, 1);
    assert.equal(Object.hasOwn(resolution.deliveryReceipts[0], 'projectionMarker'), false);
    assert.deepEqual(resolution.omittedOpportunityIds, []);
    assert.match(resolution.promptSegment, /proactive-memory-judgment/);
    assert.match(resolution.promptSegment, /message-meeting-1/);
    assert.match(resolution.promptSegment, /mechanical_observation/);
    assert.match(resolution.promptSegment, /propose \| defer \| abstain/);
    assert.doesNotMatch(resolution.promptSegment, /private transcript|importance=true|truth=true/);
    assert.equal(resolution.presentationEnvelopes.length, 1);
    assert.deepEqual(resolution.presentationEnvelopes[0].candidate, {
      subjectKey: `write-opportunity:${scene.opportunity.dedupeLineage}`,
      asOf: { kind: 'version', value: String(scene.opportunity.generation) },
      sourceTier: 'T0',
      requested: 'state',
      epistemicCeiling: 'mechanical_observation',
    });
    assert.equal(resolution.presentationEnvelopes[0].segments.pointer, undefined);
    assert.match(resolution.presentationEnvelopes[0].segments.state, /mechanical_observation/);
    assert.deepEqual(resolution.presentationEnvelopes[0].admission, {
      opportunityId: scene.opportunity.opportunityId,
      opportunityKind: 'write',
      producerOwner: 'memory/private-person-relationship',
      consumerScope: { kind: 'cat', ownerUserId: 'owner-1', threadId: 'thread-1', consumerCatId: 'codex' },
      entryVersion: 'asr-person-memory:1',
      subjectKey: `write-opportunity:${scene.opportunity.dedupeLineage}`,
      asOf: { kind: 'version', value: String(scene.opportunity.generation) },
      sourceRefs: scene.opportunity.sourceCoordinates.map((coordinate) =>
        [
          coordinate.artifactId,
          coordinate.sourceHandle,
          coordinate.sourceRevision,
          `${coordinate.segment.start}-${coordinate.segment.end}`,
          coordinate.speaker.externalSpeakerId,
          coordinate.speaker.attributionRevision,
        ].join('@'),
      ),
      eligibleSurfaces: ['dynamic_context'],
      presentationPolicyRef: 'F296.OpportunityPresentation',
      tokenBudget: 160,
      dedupeKey: `${scene.opportunity.dedupeLineage}:${scene.opportunity.generation}`,
      expiresAt: scene.opportunity.expiresAt,
      invalidators: ['source_corrected', 'source_forgotten', 'scope_revoked', 'superseded', 'expired'].map((ref) => ({
        owner: 'memory/private-person-relationship',
        ref,
      })),
      epistemicCeiling: 'mechanical_observation',
    });
    assert.ok(
      estimateTokens(resolution.presentationEnvelopes[0].segments.state) <=
        resolution.presentationEnvelopes[0].admission.tokenBudget,
    );
    assert.doesNotMatch(JSON.stringify(resolution.presentationEnvelopes[0].admission), /disposition|transcript text/);

    const deduped = new AsrPersonMemoryOpportunityPromptService().resolve({
      candidates: [boundScene(scene), boundScene(scene)],
      serverScope: { ownerUserId: 'owner-1', threadId: 'thread-1', consumerCatId: 'codex' },
      continuity: handshake(),
      now,
      terminalGenerationKeys: new Set(),
    });
    assert.equal(deduped.deliveryReceipts.length, 1);

    service.recordPresentation(resolution.deliveryReceipts, {
      outcome: 'delivered',
      continuity: handshake(),
      generationId: `sha256:${'a'.repeat(64)}`,
      evidenceRef: 'context-delivery:inv-asr-f276:generation-a',
      occurredAt: now + 1,
    });
    assert.deepEqual(
      trace.events.map((event) => [event.stage, event.outcome]),
      [
        ['eligible', 'admitted'],
        ['delivered', 'delivered'],
      ],
    );
  });

  it('fails closed for another consumer and for a carrier without the landed presentation interface', async () => {
    const now = Date.now();
    const scene = await sceneAt(now);
    const trace = new MemoryContractTrialTraceBuffer();
    const service = new AsrPersonMemoryOpportunityPromptService({ trace });
    const wrongConsumer = service.resolve({
      candidates: [boundScene(scene)],
      serverScope: { ownerUserId: 'owner-1', threadId: 'thread-1', consumerCatId: 'opus5' },
      continuity: handshake(),
      now,
      terminalGenerationKeys: new Set(),
    });
    assert.equal(wrongConsumer.promptSegment, '');

    const wrongSource = service.resolve({
      candidates: [boundScene(scene, { authorUserId: 'owner-2' })],
      serverScope: { ownerUserId: 'owner-1', threadId: 'thread-1', consumerCatId: 'codex' },
      continuity: handshake(),
      now,
      terminalGenerationKeys: new Set(),
    });
    assert.equal(wrongSource.promptSegment, '');

    const unverifiedSource = service.resolve({
      candidates: [boundScene(scene, { visibility: undefined })],
      serverScope: { ownerUserId: 'owner-1', threadId: 'thread-1', consumerCatId: 'codex' },
      continuity: handshake(),
      now,
      terminalGenerationKeys: new Set(),
    });
    assert.equal(unverifiedSource.promptSegment, '');

    const unsupported = service.resolve({
      candidates: [boundScene(scene)],
      serverScope: { ownerUserId: 'owner-1', threadId: 'thread-1', consumerCatId: 'codex' },
      continuity: resolveContextContinuity({
        capability: { ...CODEX_EXEC, provider: 'kimi', carrier: 'stream_json' },
        invocationId: 'inv-kimi',
        invocationOrigin: 'interactive',
        routeTopology: 'serial',
      }),
      now,
      terminalGenerationKeys: new Set(),
    });
    assert.equal(unsupported.promptSegment, '');
    assert.deepEqual(unsupported.omittedOpportunityIds, [scene.opportunity.opportunityId]);
  });

  it('binds delivered evidence to the final Codex prompt generation after substantive output', async () => {
    const now = Date.now();
    const scene = await sceneAt(now);
    const timeline = [];
    const service = {
      contextCapability: () => CODEX_EXEC,
      async *invoke(prompt) {
        timeline.push('provider-start');
        assert.match(prompt, /person-memory-write-opportunity/);
        assert.match(prompt, /proactive-memory-judgment/);
        yield { type: 'text', catId: 'codex', content: 'handled', timestamp: now + 1 };
        timeline.push('provider-after-text');
        yield { type: 'done', catId: 'codex', timestamp: now + 2 };
      },
    };
    const deps = {
      ...dispositionAuthority(),
      registry: {
        create: async () => ({ invocationId: 'inv-asr-f276', callbackToken: 'token-asr-f276' }),
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
      presentationLedger: presentationLedger(),
    };
    const messages = [];
    for await (const message of invokeSingleCat(deps, {
      catId: 'codex',
      service,
      prompt: 'meeting prompt',
      userId: 'owner-1',
      ownerAuthProvenance: 'unknown',
      threadId: 'thread-1',
      invocationOrigin: 'interactive',
      routeTopology: 'serial',
      asrPersonMemoryScenes: [boundScene(scene)],
      isLastCat: true,
    })) {
      messages.push(message);
    }

    const receipts = parseSystemInfo(messages, 'write_opportunity_presentation_receipt');
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].outcome, 'delivered');
    // Receipt now carries the full identity triple, not just ids: dedupeLineage is unrecoverable
    // from opportunityId, so an id-only receipt leaves the cat unable to attribute its disposition.
    assert.deepEqual(receipts[0].opportunities, [
      {
        opportunityId: scene.opportunity.opportunityId,
        dedupeLineage: scene.opportunity.dedupeLineage,
        generation: scene.opportunity.generation,
      },
    ]);
    // Still content-free.
    assert.doesNotMatch(JSON.stringify(receipts[0]), /Alden|黄挺|speaker-/);
    assert.match(receipts[0].generationId, /^sha256:[a-f0-9]{64}$/);
    assert.equal(receipts[0].continuityDispositionRef, handshake().disposition.evidenceRef);
    assert.ok(
      messages.findIndex((message) => message.content?.includes('write_opportunity_presentation_receipt')) <
        messages.findIndex((message) => message.type === 'text' && message.content === 'handled'),
    );
    assert.deepEqual(timeline, ['provider-start', 'provider-after-text']);
  });

  it('records authoritative omission when the carrier cannot present the opportunity', async () => {
    const now = Date.now();
    const scene = await sceneAt(now);
    let providerPrompt = '';
    const service = {
      contextCapability: () => ({ ...CODEX_EXEC, provider: 'kimi', carrier: 'stream_json' }),
      async *invoke(prompt) {
        providerPrompt = prompt;
        yield { type: 'text', catId: 'codex', content: 'handled without presentation', timestamp: now + 1 };
        yield { type: 'done', catId: 'codex', timestamp: now + 2 };
      },
    };
    const deps = {
      ...dispositionAuthority(),
      registry: {
        create: async () => ({ invocationId: 'inv-asr-omitted', callbackToken: 'token-asr-omitted' }),
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
      presentationLedger: presentationLedger(),
    };
    const messages = [];
    for await (const message of invokeSingleCat(deps, {
      catId: 'codex',
      service,
      prompt: 'meeting prompt',
      userId: 'owner-1',
      ownerAuthProvenance: 'unknown',
      threadId: 'thread-1',
      invocationOrigin: 'interactive',
      routeTopology: 'serial',
      asrPersonMemoryScenes: [boundScene(scene)],
      isLastCat: true,
    })) {
      messages.push(message);
    }

    assert.doesNotMatch(providerPrompt, /person-memory-write-opportunity/);
    const receipts = parseSystemInfo(messages, 'write_opportunity_presentation_receipt');
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].outcome, 'omitted');
    assert.match(receipts[0].continuityDispositionRef, /carrier_unsupported$/);
  });

  it('binds delivery only to the rebuilt generation after stale-session self-heal', async () => {
    const now = Date.now();
    const scene = await sceneAt(now);
    const prompts = [];
    let invokeCount = 0;
    let rebuildCount = 0;
    const service = {
      contextCapability: () => CODEX_EXEC,
      async *invoke(prompt) {
        prompts.push(prompt);
        invokeCount += 1;
        if (invokeCount === 1) {
          yield {
            type: 'error',
            catId: 'codex',
            error: 'No conversation found with session ID: stale-runtime-session',
            timestamp: now + 1,
          };
          yield { type: 'done', catId: 'codex', timestamp: now + 2 };
          return;
        }
        yield { type: 'text', catId: 'codex', content: 'recovered', timestamp: now + 3 };
        yield { type: 'done', catId: 'codex', timestamp: now + 4 };
      },
    };
    const deps = {
      ...dispositionAuthority(),
      registry: {
        create: async () => ({ invocationId: 'inv-asr-retry', callbackToken: 'token-asr-retry' }),
        verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      sessionManager: {
        get: async () => 'stale-runtime-session',
        store: async () => {},
        delete: async () => {},
        resolveWorkingDirectory: () => '/tmp/test',
      },
      threadStore: null,
      apiUrl: 'http://127.0.0.1:3004',
      contextEpochOwner: new ContextEpochOwner(new InMemoryContextEpochStore()),
      presentationLedger: presentationLedger(),
    };
    const messages = [];
    for await (const message of invokeSingleCat(deps, {
      catId: 'codex',
      service,
      prompt: 'possibly hot prompt',
      rebuildPromptAfterSessionSeal: async () => `cold rebuild ${++rebuildCount}`,
      userId: 'owner-1',
      ownerAuthProvenance: 'unknown',
      threadId: 'thread-1',
      invocationOrigin: 'interactive',
      routeTopology: 'serial',
      asrPersonMemoryScenes: [boundScene(scene)],
      isLastCat: true,
    })) {
      messages.push(message);
    }

    assert.equal(prompts.length, 2);
    assert.match(prompts[0], /cold rebuild 1/);
    assert.match(prompts[1], /cold rebuild 2/);
    for (const prompt of prompts) assert.equal(prompt.match(/<person-memory-write-opportunity /g)?.length, 1);
    const receipts = parseSystemInfo(messages, 'write_opportunity_presentation_receipt');
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].outcome, 'delivered');
    assert.equal(receipts[0].generationId, `sha256:${createHash('sha256').update(prompts[1]).digest('hex')}`);
  });
});
