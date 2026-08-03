import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatMemoryCues } from '../../dist/domains/memory/cue/format-memory-cues.js';
import { MemoryCuePlaneService } from '../../dist/domains/memory/cue/MemoryCuePlaneService.js';
import {
  MemoryCueResolverRegistry,
  RECALL_RESOLVER_ADMISSION_V1,
  ZERO_ONLY_V1_RESOLVER_FAMILIES,
} from '../../dist/domains/memory/cue/MemoryCueResolverRegistry.js';
import {
  admitRecallOpportunity,
  getRecallOpportunityCatalogEntry,
  RECALL_OPPORTUNITY_CATALOG_V1,
} from '../../dist/domains/memory/cue/RecallOpportunityCatalog.js';
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

function source(overrides = {}) {
  return {
    title: 'A bounded source is available',
    summary: 'The source can be drilled without preselecting a conclusion.',
    anchor: 'person:alden',
    revision: 'revision-1',
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
  };
  const registry = new MemoryCueResolverRegistry([
    new PersonEntityCueResolver(personSource),
    new OperationalPrecedentCueResolver(operationalSource),
    new TasteCueResolver(tasteSource),
    new ProfileCueResolver(),
    new ProjectKnowledgeCueResolver(),
  ]);
  const service = new MemoryCuePlaneService(registry, overrides.episodeStore);
  return { calls, registry, service };
}

const createDrillHandle = (input) =>
  `opaque:${input.family}:${input.anchor}:${input.revision}:${input.scope.ownerUserId}`;

describe('F287 RecallOpportunity catalog', () => {
  it('is closed, versioned and binds scope to server truth', () => {
    assert.equal(RECALL_OPPORTUNITY_CATALOG_V1.version, 1);
    assert.deepEqual(
      RECALL_OPPORTUNITY_CATALOG_V1.entries.map(({ kind, producer }) => ({ kind, producer })),
      [
        { kind: 'subject_seen', producer: 'entity_nudge' },
        { kind: 'delivery_decision', producer: 'github_ci' },
        { kind: 'judgment_surface_entered', producer: 'workflow_sop' },
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
  it('registers all five families while keeping profile/project knowledge zero-only in v1', async () => {
    const { registry } = makeHarness();
    assert.deepEqual(registry.families(), [
      'person_entity',
      'operational_precedent',
      'taste',
      'profile',
      'project_knowledge',
    ]);
    assert.deepEqual(ZERO_ONLY_V1_RESOLVER_FAMILIES, ['profile', 'project_knowledge']);
    assert.equal(RECALL_RESOLVER_ADMISSION_V1.profile, 'zero_only_v1');
    assert.equal(RECALL_RESOLVER_ADMISSION_V1.project_knowledge, 'zero_only_v1');
    assert.deepEqual(await registry.get('profile').resolve(subjectOpportunity, {}), []);
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

  it('keeps zero-only v1 families unreachable from every admitted catalog entry', async () => {
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
    for (const candidate of [subjectOpportunity, deliveryOpportunity, judgmentOpportunity]) {
      await service.resolve({
        candidate,
        serverScope: scope,
        invocationState: { seenDedupeKeys: new Set() },
        now: 1_001,
        createDrillHandle,
      });
    }
    assert.equal(profileCalls, 0);
    assert.equal(projectCalls, 0);
  });
});

describe('F287 MemoryCuePlaneService', () => {
  it('routes each opportunity to its single admitted lane with no cross-lane fallback', async () => {
    for (const [candidate, expectedFamily] of [
      [subjectOpportunity, 'person_entity'],
      [deliveryOpportunity, 'operational_precedent'],
      [judgmentOpportunity, 'taste'],
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
        catalogVersion: 1,
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
