import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatMemoryCues } from '../../dist/domains/memory/cue/format-memory-cues.js';
import { MemoryCuePlaneService } from '../../dist/domains/memory/cue/MemoryCuePlaneService.js';
import {
  MemoryCueResolverRegistry,
  RECALL_RESOLVER_ADMISSION_V3,
  ZERO_ONLY_V3_RESOLVER_FAMILIES,
} from '../../dist/domains/memory/cue/MemoryCueResolverRegistry.js';
import {
  admitRecallOpportunity,
  getRecallOpportunityCatalogEntry,
  RECALL_OPPORTUNITY_CATALOG_V3,
} from '../../dist/domains/memory/cue/RecallOpportunityCatalog.js';
import { EventCueResolver } from '../../dist/domains/memory/cue/resolvers/EventCueResolver.js';
import { OperationalPrecedentCueResolver } from '../../dist/domains/memory/cue/resolvers/OperationalPrecedentCueResolver.js';
import { PersonEntityCueResolver } from '../../dist/domains/memory/cue/resolvers/PersonEntityCueResolver.js';
import { ProfileCueResolver } from '../../dist/domains/memory/cue/resolvers/ProfileCueResolver.js';
import { ProjectKnowledgeCueResolver } from '../../dist/domains/memory/cue/resolvers/ProjectKnowledgeCueResolver.js';
import { TasteCueResolver } from '../../dist/domains/memory/cue/resolvers/TasteCueResolver.js';

const scope = {
  ownerUserId: 'owner-1',
  threadId: 'thread-1',
  invocationId: 'invocation-1',
};

const subjectOpportunity = {
  v: 1,
  kind: 'subject_seen',
  opportunityId: 'opportunity-subject-1',
  producer: 'entity_nudge',
  consumer: 'agent_route',
  scope,
  occurredAt: 1_000,
  payload: {
    entityId: 'entity-alden',
    matchedAlias: 'Alden',
    sourceMessageId: 'message-1',
  },
};

const deliveryOpportunity = {
  v: 1,
  kind: 'delivery_decision',
  opportunityId: 'opportunity-delivery-1',
  producer: 'github_ci',
  consumer: 'agent_route',
  scope,
  occurredAt: 1_000,
  payload: {
    repoFullName: 'zts212653/cat-cafe',
    prNumber: 3366,
    headSha: 'b83ce623eff16b0085be39801844e9b6b04c9313',
    phase: 'merge_gate',
    gateOutcome: 'source_evidence_complete',
    externalCondition: 'billing_spending_limit_zero_step',
    candidateAction: 'merge',
    sourceMessageId: 'message-2',
  },
};

const judgmentOpportunity = {
  v: 1,
  kind: 'judgment_surface_entered',
  opportunityId: 'opportunity-judgment-1',
  producer: 'workflow_sop',
  consumer: 'agent_route',
  scope,
  occurredAt: 1_000,
  payload: {
    stage: 'review',
    selectedSkill: 'request-review',
    selectionSource: 'override',
    featureId: 'F287',
  },
};

const explicitTasteOpportunity = {
  v: 1,
  kind: 'approved_taste_invoked',
  opportunityId: 'opportunity-explicit-taste-1',
  producer: 'owner_message',
  consumer: 'agent_route',
  scope,
  occurredAt: 1_000,
  payload: {
    triggerKey: 'ELI5',
    sourceMessageId: 'message-3',
  },
};

const profileOpportunity = {
  v: 1,
  kind: 'profile_revision_available',
  opportunityId: 'opportunity-profile-1',
  producer: 'profile_repository',
  consumer: 'agent_route',
  scope,
  occurredAt: 1_000,
  payload: {
    profileUri: 'cat-cafe-profile://relationship/current',
    sourceRevision: 'sha256:profile-revision-1',
  },
};

const eventOpportunity = {
  v: 1,
  kind: 'recent_event_available',
  opportunityId: 'opportunity-event-1',
  producer: 'event_memory',
  consumer: 'agent_route',
  scope,
  occurredAt: 1_000,
  payload: {
    eventId: 'evt_1',
    subjectThreadId: scope.threadId,
    sourceRevision: 'sha256:event-revision-1',
  },
};

function source(overrides = {}) {
  return {
    title: 'A bounded source is available',
    summary: 'The source can be drilled without preselecting a conclusion.',
    anchor: 'person:alden',
    revision: 'revision-1',
    asOf: 1_000,
    visibility: 'owner_private',
    drillFamily: 'person_memory',
    ...overrides,
  };
}

function makeHarness(overrides = {}) {
  const calls = [];
  const personSource = {
    async resolve(input) {
      calls.push({ family: 'person_entity', input });
      return overrides.personSource === undefined ? source() : overrides.personSource;
    },
  };
  const operationalSource = {
    async resolve(input) {
      calls.push({ family: 'operational_precedent', input });
      return overrides.operationalSource === undefined
        ? source({
            title: 'A delivery precedent is available',
            anchor: 'lesson:billing-only',
            revision: 'lesson-revision-1',
            visibility: 'owner_public',
            drillFamily: 'evidence',
          })
        : overrides.operationalSource;
    },
  };
  const tasteSource = {
    async resolve(input) {
      calls.push({ family: 'taste', input });
      return overrides.tasteSource === undefined
        ? {
            dimensions: ['system-philosophy', 'cognitive-honesty'],
            revision: 'taste-map-v1',
          }
        : overrides.tasteSource;
    },
    async resolveExplicit(input) {
      calls.push({ family: 'taste', input });
      return overrides.explicitTasteSource === undefined
        ? {
            triggerKey: 'ELI5',
            sourcePath: 'docs/taste/vignettes/visual-quality-ELI5-pcpjsd.md',
            revision: 'taste-vignette-v1',
            visibility: 'owner_public',
          }
        : overrides.explicitTasteSource;
    },
  };
  const profileSource = {
    async resolve(input) {
      calls.push({ family: 'profile', input });
      return overrides.profileSource === undefined
        ? source({
            title: 'A current Profile revision is available',
            anchor: 'profile:cat-cafe-profile://relationship/current',
            revision: 'sha256:profile-revision-1',
            drillFamily: 'profile',
          })
        : overrides.profileSource;
    },
  };
  const eventSource = {
    async resolve(input) {
      calls.push({ family: 'event', input });
      return overrides.eventSource === undefined
        ? source({
            title: 'A recent Event is available',
            anchor: 'event-memory:evt_1',
            revision: 'sha256:event-revision-1',
            drillFamily: 'event',
          })
        : overrides.eventSource;
    },
  };
  const registry = new MemoryCueResolverRegistry([
    new PersonEntityCueResolver(personSource),
    new OperationalPrecedentCueResolver(operationalSource),
    new TasteCueResolver(tasteSource),
    new ProfileCueResolver(profileSource),
    new EventCueResolver(eventSource),
    new ProjectKnowledgeCueResolver(),
  ]);
  const service = new MemoryCuePlaneService(registry, overrides.episodeStore);
  return { calls, registry, service };
}

const createDrillHandle = (input) =>
  `opaque:${input.family}:${input.anchor}:${input.revision}:${input.scope.ownerUserId}`;

// Production handles are encrypted, entropy-dense capabilities. A short test
// double hides whether the catalog budget can carry the real presentation.
const productionSizedDrillHandle =
  'mch1.uOX7C7t5bClBKtMj.qrXdJADzsaRQ6ce-3kwO8VNa0W8PSdEnzUoIB5Bg6mO5_6Rv2WTcVpj38NplHBf_Cf10kDzjabF8_Ug3l53zs2awGZwPer9wsiyWuo_voA.1RjeRSG4837GkoSCJUbWGQ';

describe('F287 RecallOpportunity catalog', () => {
  it('is closed, versioned and binds scope to server truth', () => {
    assert.equal(RECALL_OPPORTUNITY_CATALOG_V3.version, 3);
    assert.deepEqual(
      RECALL_OPPORTUNITY_CATALOG_V3.entries.map(({ kind, producer }) => ({ kind, producer })),
      [
        { kind: 'subject_seen', producer: 'entity_nudge' },
        { kind: 'delivery_decision', producer: 'github_ci' },
        { kind: 'judgment_surface_entered', producer: 'workflow_sop' },
        { kind: 'approved_taste_invoked', producer: 'owner_message' },
        { kind: 'profile_revision_available', producer: 'profile_repository' },
        { kind: 'recent_event_available', producer: 'event_memory' },
      ],
    );
    assert.deepEqual(admitRecallOpportunity(subjectOpportunity, scope), subjectOpportunity);
    assert.equal(admitRecallOpportunity(subjectOpportunity, { ...scope, ownerUserId: 'owner-2' }), null);
    assert.equal(admitRecallOpportunity({ ...subjectOpportunity, kind: 'raw_query' }, scope), null);
    assert.equal(admitRecallOpportunity({ ...subjectOpportunity, rawQuery: 'all memories' }, scope), null);
    assert.equal(admitRecallOpportunity({ ...subjectOpportunity, globalScore: 1 }, scope), null);
    assert.equal(admitRecallOpportunity({ ...subjectOpportunity, wholeLibrary: ['everything'] }, scope), null);
  });

  it('declares deterministic resolver, dedupe, budget and expiry policy per entry', () => {
    const subject = getRecallOpportunityCatalogEntry(subjectOpportunity);
    assert.deepEqual(subject.resolverFamilies, ['person_entity']);
    assert.equal(subject.dedupeKey(subjectOpportunity), 'subject_seen\0entity-alden');
    assert.ok(subject.maxPromptTokens > 0);
    assert.ok(subject.expiresAfterMs > 0);
  });
});

describe('F287 MemoryCueResolverRegistry', () => {
  it('registers all six families while keeping only project knowledge zero-only in v3', async () => {
    const { registry } = makeHarness();
    assert.deepEqual(registry.families(), [
      'person_entity',
      'operational_precedent',
      'taste',
      'profile',
      'event',
      'project_knowledge',
    ]);
    assert.deepEqual(ZERO_ONLY_V3_RESOLVER_FAMILIES, ['project_knowledge']);
    assert.equal(RECALL_RESOLVER_ADMISSION_V3.profile, 'catalog');
    assert.equal(RECALL_RESOLVER_ADMISSION_V3.event, 'catalog');
    assert.equal(RECALL_RESOLVER_ADMISSION_V3.project_knowledge, 'zero_only_v3');
    assert.equal(
      (
        await registry.get('profile').resolve(profileOpportunity, {
          now: 1_000,
          expiresAt: 301_000,
          createDrillHandle,
        })
      ).length,
      1,
    );
    assert.equal(
      (
        await registry.get('event').resolve(eventOpportunity, {
          now: 1_000,
          expiresAt: 301_000,
          createDrillHandle,
        })
      ).length,
      1,
    );
    assert.deepEqual(await registry.get('project_knowledge').resolve(subjectOpportunity, {}), []);
  });

  it('fails closed when a family is missing or duplicated', () => {
    assert.throws(() => new MemoryCueResolverRegistry([new ProfileCueResolver()]));
    assert.throws(
      () =>
        new MemoryCueResolverRegistry([
          new ProfileCueResolver(),
          new ProfileCueResolver(),
          new ProjectKnowledgeCueResolver(),
        ]),
      /duplicate/i,
    );
    assert.throws(
      () =>
        new MemoryCueResolverRegistry([
          ...makeHarness()
            .registry.families()
            .map((family) => ({
              family,
              resolverVersion: 1,
              async resolve() {
                return [];
              },
            })),
          {
            family: 'global_search',
            resolverVersion: 1,
            async resolve() {
              return [];
            },
          },
        ]),
      /unknown/i,
    );
  });

  it('keeps zero-only v3 families unreachable from every admitted catalog entry', async () => {
    let profileCalls = 0;
    let projectCalls = 0;
    const { registry } = makeHarness();
    const resolvers = registry.families().map((family) => {
      if (family === 'profile') {
        return {
          family,
          resolverVersion: 1,
          async resolve() {
            profileCalls += 1;
            return [];
          },
        };
      }
      if (family === 'project_knowledge') {
        return {
          family,
          resolverVersion: 1,
          async resolve() {
            projectCalls += 1;
            return [];
          },
        };
      }
      return registry.get(family);
    });
    const service = new MemoryCuePlaneService(new MemoryCueResolverRegistry(resolvers));
    for (const candidate of [
      subjectOpportunity,
      deliveryOpportunity,
      judgmentOpportunity,
      explicitTasteOpportunity,
      profileOpportunity,
      eventOpportunity,
    ]) {
      await service.resolve({
        candidate,
        serverScope: scope,
        invocationState: { seenDedupeKeys: new Set() },
        now: 1_001,
        createDrillHandle,
      });
    }
    assert.equal(profileCalls, 1);
    assert.equal(projectCalls, 0);
  });
});

describe('F287 MemoryCuePlaneService', () => {
  it('admits Profile and Event cues with production-sized drill handles', async () => {
    for (const [candidate, expectedFamily, sourceProjection] of [
      [
        profileOpportunity,
        'profile',
        {
          title: 'A current owner Profile revision is available',
          summary: 'Drill the bounded approved capsule and use it only to personalize this owner-facing response.',
          anchor: 'profile:cat-cafe-profile://relationship/current',
          revision: 'sha256:38047ae158f7443fd1cff652c8a72167a4451f2f85e3a0fe32273bef991ca703',
          visibility: 'owner_private',
          drillFamily: 'profile',
        },
      ],
      [
        eventOpportunity,
        'event',
        {
          title: 'A recent event can establish continuity',
          summary:
            'Drill the bounded Event record before using it to establish chronology or continuity in this thread.',
          anchor: 'event-memory:evt_mtk5wba0djs1nduh',
          revision: 'sha256:69117d827b74fee6d257f7cf119a28ece0c99157ac72213a922d3d13998a4d6b',
          asOf: 1_788_357_527_064,
          visibility: 'owner_private',
          drillFamily: 'event',
        },
      ],
    ]) {
      const { service } = makeHarness({
        ...(expectedFamily === 'profile' ? { profileSource: sourceProjection } : { eventSource: sourceProjection }),
      });
      const result = await service.resolve({
        candidate,
        serverScope: scope,
        invocationState: { seenDedupeKeys: new Set() },
        now: 1_001,
        createDrillHandle: () => productionSizedDrillHandle,
      });

      assert.equal(result.status, 'admitted');
      assert.equal(result.cues.length, 1, `${expectedFamily} cue was dropped by its prompt budget`);
      assert.match(result.promptSegment, new RegExp(productionSizedDrillHandle.replaceAll('.', '\\.')));
    }
  });

  it('routes each opportunity to its single admitted lane with no cross-lane fallback', async () => {
    for (const [candidate, expectedFamily] of [
      [subjectOpportunity, 'person_entity'],
      [deliveryOpportunity, 'operational_precedent'],
      [judgmentOpportunity, 'taste'],
      [explicitTasteOpportunity, 'taste'],
      [profileOpportunity, 'profile'],
      [eventOpportunity, 'event'],
    ]) {
      const { calls, service } = makeHarness();
      const result = await service.resolve({
        candidate,
        serverScope: scope,
        invocationState: { seenDedupeKeys: new Set() },
        now: 1_001,
        createDrillHandle,
      });

      assert.equal(result.status, 'admitted');
      assert.equal(result.cues.length, 1);
      assert.equal(result.cues[0].resolverFamily, expectedFamily);
      assert.deepEqual(
        calls.map((call) => call.family),
        [expectedFamily],
      );
      assert.equal(Object.hasOwn(result.cues[0], 'globalScore'), false);
      assert.equal(Object.hasOwn(result.cues[0], 'conclusion'), false);
      const pointer = result.presentationEnvelopes[0].segments.pointer;
      assert.match(pointer, /<recall-opportunity-pointer/);
      assert.match(pointer, /Drill:/);
      assert.doesNotMatch(pointer, new RegExp(result.cues[0].title));
      assert.doesNotMatch(pointer, new RegExp(result.cues[0].summary));
      assert.deepEqual(result.presentationEnvelopes[0].admission, {
        opportunityId: candidate.opportunityId,
        opportunityKind: 'recall',
        producerOwner: candidate.producer,
        consumerScope: { kind: 'invocation', ...scope },
        entryVersion: `recall-catalog:3:${candidate.kind}:${candidate.producer}`,
        subjectKey: `memory-cue:${expectedFamily}:${result.cues[0].source.anchor}`,
        asOf: { kind: 'version', value: result.cues[0].source.revision },
        sourceRefs: [result.cues[0].source.anchor],
        eligibleSurfaces: ['dynamic_context', 'pointer'],
        presentationPolicyRef: 'F296.OpportunityPresentation',
        tokenBudget: getRecallOpportunityCatalogEntry(candidate).maxPromptTokens,
        dedupeKey: getRecallOpportunityCatalogEntry(candidate).dedupeKey(candidate),
        expiresAt: result.cues[0].expiresAt,
        invalidators: result.cues[0].invalidators.map((ref) => ({ owner: candidate.producer, ref })),
        epistemicCeiling: 'pointer',
      });
      assert.doesNotMatch(
        JSON.stringify(result.presentationEnvelopes[0].admission),
        new RegExp(`${result.cues[0].title}|${result.cues[0].summary}`),
      );
    }
  });

  it('records presented only after a whole cue enters the assembled prompt', async () => {
    const appended = [];
    const episodeStore = {
      append(event) {
        appended.push(event);
      },
    };
    const { service } = makeHarness({ episodeStore });
    const result = await service.resolve({
      candidate: subjectOpportunity,
      serverScope: scope,
      invocationState: { seenDedupeKeys: new Set() },
      now: 1_001,
      createDrillHandle,
    });

    assert.equal(result.cues.length, 1);
    assert.deepEqual(appended, []);
    assert.equal(result.deliveryReceipts.length, 1);
    assert.equal(Object.hasOwn(result.deliveryReceipts[0], 'projectionMarker'), false);
    await service.recordPresented(result.deliveryReceipts, {
      generationId: 'sha256:final-provider-prompt',
      evidenceRef: 'context-delivery:invocation-1:sha256:final-provider-prompt',
    });
    assert.deepEqual(appended, [
      {
        eventId: appended[0].eventId,
        idempotencyKey: appended[0].idempotencyKey,
        cueId: result.cues[0].cueId,
        opportunityId: subjectOpportunity.opportunityId,
        scope,
        resolverFamily: 'person_entity',
        sourceAnchor: 'person:alden',
        sourceRevision: 'revision-1',
        axis: 'consumption',
        consumptionOutcome: 'presented',
        catalogVersion: 3,
        resolverVersion: 1,
        occurredAt: subjectOpportunity.occurredAt,
      },
    ]);
    assert.equal(JSON.stringify(appended).includes(result.cues[0].summary), false);

    const { service: zeroService } = makeHarness({ personSource: null, episodeStore });
    await zeroService.resolve({
      candidate: { ...subjectOpportunity, opportunityId: 'opportunity-zero' },
      serverScope: scope,
      invocationState: { seenDedupeKeys: new Set() },
      now: 1_001,
      createDrillHandle,
    });
    assert.equal(appended.length, 1);
  });

  it('makes unknown, unauthorized, deleted and invalid source states first-class zero results', async () => {
    for (const candidate of [
      { ...subjectOpportunity, kind: 'unknown' },
      { ...subjectOpportunity, scope: { ...scope, ownerUserId: 'owner-2' } },
      { ...subjectOpportunity, rawQuery: 'search everything' },
    ]) {
      const { calls, service } = makeHarness();
      const result = await service.resolve({
        candidate,
        serverScope: scope,
        invocationState: { seenDedupeKeys: new Set() },
        now: 1_001,
        createDrillHandle,
      });
      assert.equal(result.status, 'not_admitted');
      assert.deepEqual(result.cues, []);
      assert.deepEqual(calls, []);
    }

    const { calls, service } = makeHarness({ personSource: null });
    const result = await service.resolve({
      candidate: subjectOpportunity,
      serverScope: scope,
      invocationState: { seenDedupeKeys: new Set() },
      now: 1_001,
      createDrillHandle,
    });
    assert.equal(result.status, 'admitted');
    assert.deepEqual(result.cues, []);
    assert.deepEqual(
      calls.map((call) => call.family),
      ['person_entity'],
    );
  });

  it('dedupes per invocation and expires without process-global mutable state', async () => {
    const { calls, service } = makeHarness();
    const invocationState = { seenDedupeKeys: new Set() };
    const input = {
      candidate: subjectOpportunity,
      serverScope: scope,
      invocationState,
      now: 1_001,
      createDrillHandle,
    };

    assert.equal((await service.resolve(input)).status, 'admitted');
    assert.equal((await service.resolve(input)).status, 'duplicate');
    assert.equal(calls.length, 1);
    assert.equal(
      (
        await service.resolve({
          ...input,
          invocationState: { seenDedupeKeys: new Set() },
        })
      ).status,
      'admitted',
    );
    assert.equal(
      (
        await service.resolve({
          ...input,
          invocationState: { seenDedupeKeys: new Set() },
          now: 1_000 + getRecallOpportunityCatalogEntry(subjectOpportunity).expiresAfterMs + 1,
        })
      ).status,
      'expired',
    );
  });

  it('drops over-budget prompt blocks as whole cues and is byte-deterministic', async () => {
    const { service } = makeHarness();
    const first = await service.resolve({
      candidate: subjectOpportunity,
      serverScope: scope,
      invocationState: { seenDedupeKeys: new Set() },
      now: 1_001,
      createDrillHandle,
    });
    const second = await service.resolve({
      candidate: subjectOpportunity,
      serverScope: scope,
      invocationState: { seenDedupeKeys: new Set() },
      now: 1_001,
      createDrillHandle,
    });
    assert.equal(JSON.stringify(first), JSON.stringify(second));

    const overBudget = formatMemoryCues(first.cues, { maxTokens: 1 });
    assert.deepEqual(overBudget.cues, []);
    assert.equal(overBudget.text, '');
    assert.equal(overBudget.estimatedTokens, 0);
  });
});
