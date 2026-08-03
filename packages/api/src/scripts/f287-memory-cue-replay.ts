import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  RECALL_OPPORTUNITY_CATALOG_VERSION,
  type RecallOpportunityV1,
  type RecallResolverFamily,
  type RecallScopeV1,
} from '@cat-cafe/shared';
import { formatMemoryCues } from '../domains/memory/cue/format-memory-cues.js';
import {
  type MemoryCueDrillCoordinate,
  MemoryCueDrillHandleService,
} from '../domains/memory/cue/MemoryCueDrillHandleService.js';
import { MemoryCuePlaneService } from '../domains/memory/cue/MemoryCuePlaneService.js';
import { type MemoryCueResolver, MemoryCueResolverRegistry } from '../domains/memory/cue/MemoryCueResolverRegistry.js';
import { getRecallOpportunityCatalogEntry } from '../domains/memory/cue/RecallOpportunityCatalog.js';
import { OperationalPrecedentCueResolver } from '../domains/memory/cue/resolvers/OperationalPrecedentCueResolver.js';
import { PersonEntityCueResolver } from '../domains/memory/cue/resolvers/PersonEntityCueResolver.js';
import { ProfileCueResolver } from '../domains/memory/cue/resolvers/ProfileCueResolver.js';
import { ProjectKnowledgeCueResolver } from '../domains/memory/cue/resolvers/ProjectKnowledgeCueResolver.js';
import { TasteCueResolver } from '../domains/memory/cue/resolvers/TasteCueResolver.js';
import { CanonicalOperationalPrecedentCueSource } from '../domains/memory/cue/sources/OperationalPrecedentCueSource.js';
import { PersonMemoryCueSource } from '../domains/memory/cue/sources/PersonMemoryCueSource.js';
import { CanonicalTasteMemoryCueSource } from '../domains/memory/cue/sources/TasteMemoryCueSource.js';
import type { EvidenceItem } from '../domains/memory/interfaces.js';
import type { PersonMemoryRecallService } from '../domains/memory/people/PersonMemoryRecallService.js';

const OWNER_SCOPE: RecallScopeV1 = Object.freeze({
  ownerUserId: 'f287-eval-owner',
  threadId: 'f287-eval-thread',
  invocationId: 'f287-eval-invocation',
});
const NOW = 10_001;

type EvaluatedFamily = Extract<RecallResolverFamily, 'person_entity' | 'operational_precedent' | 'taste'>;
type FixtureSourceState = 'relevant' | 'irrelevant' | 'budget';
type UtilityVerdict = 'keep' | 'tune' | 'sunset';

interface CountConstraint {
  readonly opportunities: number;
  readonly presented: number;
}

interface SourceLifecycleConstraint extends CountConstraint {
  readonly drillStatus: 'ok' | 'not_available' | 'not_attempted';
  readonly invalidationReason?: string;
}

interface PrivateDrillConstraint extends CountConstraint {
  readonly drillStatus: 'ok' | 'not_available' | 'not_attempted';
  readonly denialReason?: string;
}

export interface F287MemoryCueConstraintVector {
  readonly relevant: CountConstraint;
  readonly irrelevant: CountConstraint;
  readonly duplicate: { readonly replays: number; readonly additionalPresented: number };
  readonly budget: CountConstraint & {
    readonly maxPromptTokens: number;
    readonly candidateEstimatedTokens: number;
  };
  readonly sourceCorrected: SourceLifecycleConstraint;
  readonly sourceForgotten: SourceLifecycleConstraint;
  readonly privateUnavailable: PrivateDrillConstraint;
  readonly crossOwner: CountConstraint;
  readonly unknownEvent: CountConstraint;
}

export interface F287MemoryCueFamilyReplayResult {
  readonly family: EvaluatedFamily;
  readonly verdict: UtilityVerdict;
  readonly verdictBasis: 'frozen_fixture_contract';
  readonly vector: F287MemoryCueConstraintVector;
  readonly hardConstraintFailures: readonly string[];
}

export interface F287MemoryCueReplayResult {
  readonly fixtureRevision: 'f287-memory-cue-eval-v1';
  readonly catalogVersion: typeof RECALL_OPPORTUNITY_CATALOG_VERSION;
  readonly families: readonly F287MemoryCueFamilyReplayResult[];
}

function makeOpportunity(family: EvaluatedFamily, scope: RecallScopeV1 = OWNER_SCOPE): RecallOpportunityV1 {
  if (family === 'person_entity') {
    return {
      v: 1,
      kind: 'subject_seen',
      opportunityId: 'f287-eval-person-opportunity',
      producer: 'entity_nudge',
      consumer: 'agent_route',
      scope,
      occurredAt: 10_000,
      payload: {
        entityId: 'person:alden',
        matchedAlias: 'Alden',
        sourceMessageId: 'f287-eval-person-message',
      },
    };
  }
  if (family === 'operational_precedent') {
    return {
      v: 1,
      kind: 'delivery_decision',
      opportunityId: 'f287-eval-operational-opportunity',
      producer: 'github_ci',
      consumer: 'agent_route',
      scope,
      occurredAt: 10_000,
      payload: {
        repoFullName: 'zts212653/cat-cafe',
        prNumber: 287,
        headSha: '2870000000000000000000000000000000000000',
        phase: 'merge_gate',
        gateOutcome: 'source_evidence_complete',
        externalCondition: 'billing_spending_limit_zero_step',
        candidateAction: 'merge',
        sourceMessageId: 'f287-eval-operational-message',
      },
    };
  }
  return {
    v: 1,
    kind: 'judgment_surface_entered',
    opportunityId: 'f287-eval-taste-opportunity',
    producer: 'workflow_sop',
    consumer: 'agent_route',
    scope,
    occurredAt: 10_000,
    payload: {
      stage: 'review',
      selectedSkill: 'request-review',
      selectionSource: 'override',
      featureId: 'F287',
    },
  };
}

function shouldProject(state: FixtureSourceState): boolean {
  return state === 'relevant' || state === 'budget';
}

function sourceProjection(state: FixtureSourceState) {
  if (!shouldProject(state)) return null;
  return {
    title: 'A bounded source is available',
    summary: 'The canonical source can be drilled without preselecting a conclusion.',
    anchor: 'person-memory:person-alden',
    revision: 'person-revision-v1',
    visibility: 'owner_private' as const,
    drillFamily: 'person_memory' as const,
  };
}

function createRegistry(state: FixtureSourceState): MemoryCueResolverRegistry {
  return new MemoryCueResolverRegistry([
    new PersonEntityCueResolver({
      async resolve(input) {
        if (input.ownerUserId !== OWNER_SCOPE.ownerUserId || input.entityId !== 'person:alden') return null;
        return sourceProjection(state);
      },
    }),
    new OperationalPrecedentCueResolver({
      async resolve(input) {
        if (
          input.ownerUserId !== OWNER_SCOPE.ownerUserId ||
          input.repoFullName !== 'zts212653/cat-cafe' ||
          input.externalCondition !== 'billing_spending_limit_zero_step'
        ) {
          return null;
        }
        if (!shouldProject(state)) return null;
        return {
          title: 'A billing-only delivery precedent is available',
          summary: 'The exact operational precedent can be drilled before choosing the merge action.',
          anchor: 'lesson:LL-098',
          revision: 'lesson-revision-v1',
          visibility: 'owner_public',
          drillFamily: 'evidence',
        };
      },
    }),
    new TasteCueResolver({
      async resolve(input) {
        if (input.ownerUserId !== OWNER_SCOPE.ownerUserId || input.featureId !== 'F287') return null;
        if (!shouldProject(state)) return null;
        return {
          dimensions: ['cognitive-honesty', 'architecture-aesthetics'],
          revision: 'taste-map-revision-v1',
          visibility: 'owner_private',
        };
      },
    }),
    new ProfileCueResolver(),
    new ProjectKnowledgeCueResolver(),
  ]);
}

function createDrillHandle(oversized: boolean): (input: { family: string; anchor: string }) => string {
  return (input) =>
    oversized ? `opaque:${input.family}:${'123456'.repeat(316)}` : `opaque:${input.family}:${input.anchor}:f287-eval`;
}

async function resolveOnce(input: {
  readonly family: EvaluatedFamily;
  readonly sourceState: FixtureSourceState;
  readonly candidate?: unknown;
  readonly serverScope?: RecallScopeV1;
  readonly invocationState?: { readonly seenDedupeKeys: Set<string> };
  readonly oversizedHandle?: boolean;
}) {
  const service = new MemoryCuePlaneService(createRegistry(input.sourceState));
  return service.resolve({
    candidate: input.candidate ?? makeOpportunity(input.family),
    serverScope: input.serverScope ?? OWNER_SCOPE,
    invocationState: input.invocationState ?? { seenDedupeKeys: new Set() },
    now: NOW,
    createDrillHandle: createDrillHandle(input.oversizedHandle ?? false),
  });
}

async function estimateBudgetCandidateTokens(family: EvaluatedFamily): Promise<number> {
  const opportunity = makeOpportunity(family);
  const resolver: MemoryCueResolver = createRegistry('budget').get(family);
  const candidates = await resolver.resolve(opportunity, {
    now: NOW,
    expiresAt: opportunity.occurredAt + getRecallOpportunityCatalogEntry(opportunity).expiresAfterMs,
    createDrillHandle: createDrillHandle(true),
  });
  return formatMemoryCues(candidates, { maxTokens: Number.MAX_SAFE_INTEGER }).estimatedTokens;
}

type SourceLifecycleMutation = 'source_corrected' | 'source_forgotten';

interface LifecycleHarness {
  readonly resolver: MemoryCueResolver;
  mutate(state: SourceLifecycleMutation): void;
  read(coordinate: MemoryCueDrillCoordinate): Promise<{
    status: 'ok' | 'not_available';
    invalidationReason?: string;
  }>;
  dispose(): void;
}

function createPersonLifecycleHarness(): LifecycleHarness {
  let available = true;
  let card = {
    personId: 'person-alden',
    displayName: 'Alden',
    facts: [
      {
        claimId: 'claim-alden-v1',
        text: 'Prefers exact source evidence.',
        kind: 'reported_fact',
        provenanceRefs: [{ kind: 'message', threadId: 'thread-history', messageId: 'message-history' }],
      },
    ],
    relationshipId: 'relationship-alden',
    uncertainty: [],
    provenanceRefs: [{ kind: 'message', threadId: 'thread-history', messageId: 'message-history' }],
    dossierRef: 'person-alden',
    estimatedTokens: 24,
    storable: false,
    indexable: false,
  };
  const recall = {
    async recallByWorkspaceEntityRef(ownerUserId: string, entityRef: string) {
      return available && ownerUserId === OWNER_SCOPE.ownerUserId && entityRef === 'person:alden'
        ? { status: 'resolved' as const, card }
        : { status: 'not_available' as const };
    },
    async recallByPersonId(ownerUserId: string, personId: string) {
      return available && ownerUserId === OWNER_SCOPE.ownerUserId && personId === card.personId
        ? { status: 'resolved' as const, card }
        : { status: 'not_available' as const };
    },
  };
  const source = new PersonMemoryCueSource({
    recall: recall as unknown as PersonMemoryRecallService,
    messageStore: {
      getById: async (messageId: string) =>
        messageId === 'f287-eval-person-message'
          ? {
              id: messageId,
              threadId: OWNER_SCOPE.threadId,
              userId: OWNER_SCOPE.ownerUserId,
              catId: null,
              content: 'Alden is here',
              mentions: [],
              timestamp: 10_000,
            }
          : null,
    },
  });
  return {
    resolver: new PersonEntityCueResolver(source),
    mutate(state) {
      if (state === 'source_forgotten') {
        available = false;
        return;
      }
      card = {
        ...card,
        facts: [{ ...card.facts[0], claimId: 'claim-alden-v2', text: 'Prefers corrected source evidence.' }],
      };
    },
    read: (coordinate) =>
      source.read({
        ownerUserId: coordinate.scope.ownerUserId,
        anchor: coordinate.anchor,
        expectedRevision: coordinate.revision,
      }),
    dispose() {},
  };
}

function createOperationalLifecycleHarness(): LifecycleHarness {
  let item: EvidenceItem | null = {
    anchor: 'LL-098',
    kind: 'lesson',
    status: 'active',
    title: 'Zero-step billing is external infrastructure',
    summary: 'runner_id=0 and steps=[] prove no source code ran.',
    sourceHash: 'billing-lesson-v1',
    updatedAt: '2026-08-01T00:00:00.000Z',
  };
  const source = new CanonicalOperationalPrecedentCueSource({
    getByAnchor: async () => item,
  });
  return {
    resolver: new OperationalPrecedentCueResolver(source),
    mutate(state) {
      if (state === 'source_forgotten') {
        item = null;
        return;
      }
      if (item) item = { ...item, sourceHash: 'billing-lesson-v2' };
    },
    read: (coordinate) =>
      source.read({
        anchor: coordinate.anchor,
        expectedRevision: coordinate.revision,
      }),
    dispose() {},
  };
}

function tasteVignette(quote: string): string {
  return `---
status: approved
when: "reviewing a consequential system change"
quotes:
  - "${quote}"
scene: "The evaluator revalidates the canonical Taste source before drill."
tags:
  - review
dimension: cognitive-honesty
---
`;
}

function createTasteLifecycleHarness(): LifecycleHarness {
  const root = mkdtempSync(join(tmpdir(), 'f287-memory-cue-eval-taste-'));
  const publicDirectory = join(root, 'docs/taste/vignettes');
  mkdirSync(publicDirectory, { recursive: true });
  const vignettePath = join(publicDirectory, 'cognitive-honesty.md');
  writeFileSync(vignettePath, tasteVignette('Name the missing evidence before making the claim.'));
  writeFileSync(
    join(publicDirectory, 'architecture-aesthetics.md'),
    tasteVignette('Keep one canonical source and one bounded projection.').replace(
      'dimension: cognitive-honesty',
      'dimension: architecture-aesthetics',
    ),
  );
  const repository = {
    canonicalRoot: () => root,
    approvalLockKey: () => join(root, 'docs/taste/index.md'),
  };
  const source = new CanonicalTasteMemoryCueSource(repository, OWNER_SCOPE.ownerUserId);
  return {
    resolver: new TasteCueResolver(source),
    mutate(state) {
      if (state === 'source_forgotten') {
        rmSync(publicDirectory, { recursive: true, force: true });
        return;
      }
      writeFileSync(vignettePath, tasteVignette('Corrected canonical Taste evidence.'));
    },
    read: (coordinate) =>
      source.read({
        ownerUserId: coordinate.scope.ownerUserId,
        anchor: coordinate.anchor,
        expectedRevision: coordinate.revision,
      }),
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

function createLifecycleHarness(family: EvaluatedFamily): LifecycleHarness {
  if (family === 'person_entity') return createPersonLifecycleHarness();
  if (family === 'operational_precedent') return createOperationalLifecycleHarness();
  return createTasteLifecycleHarness();
}

function createLifecycleRegistry(family: EvaluatedFamily, resolver: MemoryCueResolver): MemoryCueResolverRegistry {
  return new MemoryCueResolverRegistry([
    family === 'person_entity' ? resolver : new PersonEntityCueResolver({ resolve: async () => null }),
    family === 'operational_precedent' ? resolver : new OperationalPrecedentCueResolver({ resolve: async () => null }),
    family === 'taste' ? resolver : new TasteCueResolver({ resolve: async () => null }),
    new ProfileCueResolver(),
    new ProjectKnowledgeCueResolver(),
  ]);
}

async function resolveLifecyclePresentation(family: EvaluatedFamily, harness: LifecycleHarness) {
  let presentedCoordinate: MemoryCueDrillCoordinate | null = null;
  const handles = new MemoryCueDrillHandleService(Buffer.alloc(32, family.length), {
    findPresentedCoordinate(scope, cueId, expiresAt) {
      if (
        !presentedCoordinate ||
        presentedCoordinate.cueId !== cueId ||
        presentedCoordinate.expiresAt !== expiresAt ||
        presentedCoordinate.scope.ownerUserId !== scope.ownerUserId ||
        presentedCoordinate.scope.threadId !== scope.threadId ||
        presentedCoordinate.scope.invocationId !== scope.invocationId
      ) {
        return null;
      }
      return presentedCoordinate;
    },
  });
  const service = new MemoryCuePlaneService(createLifecycleRegistry(family, harness.resolver));
  const resolution = await service.resolve({
    candidate: makeOpportunity(family),
    serverScope: OWNER_SCOPE,
    invocationState: { seenDedupeKeys: new Set() },
    now: NOW,
    createDrillHandle: (coordinate) => {
      presentedCoordinate = coordinate;
      return handles.issue(coordinate);
    },
  });
  return { handles, resolution };
}

async function evaluateSourceLifecycle(
  family: EvaluatedFamily,
  mutation: SourceLifecycleMutation,
): Promise<SourceLifecycleConstraint> {
  const harness = createLifecycleHarness(family);
  try {
    const { handles, resolution } = await resolveLifecyclePresentation(family, harness);
    const cue = resolution.cues[0];
    if (!cue) return { opportunities: 1, presented: 0, drillStatus: 'not_attempted' };
    const verified = handles.verify(cue.drill.handle, OWNER_SCOPE, NOW);
    if (!verified.ok) return { opportunities: 1, presented: 1, drillStatus: 'not_attempted' };
    harness.mutate(mutation);
    const drilled = await harness.read(verified.coordinate);
    return {
      opportunities: 1,
      presented: 1,
      drillStatus: drilled.status,
      ...(drilled.invalidationReason ? { invalidationReason: drilled.invalidationReason } : {}),
    };
  } finally {
    harness.dispose();
  }
}

async function evaluatePrivateDrill(family: EvaluatedFamily): Promise<PrivateDrillConstraint> {
  const harness = createLifecycleHarness(family);
  try {
    const { handles, resolution } = await resolveLifecyclePresentation(family, harness);
    const cue = resolution.cues[0];
    if (!cue) return { opportunities: 1, presented: 0, drillStatus: 'not_attempted' };
    const verified = handles.verify(cue.drill.handle, { ...OWNER_SCOPE, ownerUserId: 'other-owner' }, NOW);
    return verified.ok
      ? { opportunities: 1, presented: 1, drillStatus: 'ok' }
      : { opportunities: 1, presented: 1, drillStatus: 'not_available', denialReason: verified.reason };
  } finally {
    harness.dispose();
  }
}

function findFailures(vector: F287MemoryCueConstraintVector): string[] {
  return [
    ...(vector.relevant.presented === 1 ? [] : ['relevant_not_presented']),
    ...(vector.irrelevant.presented === 0 ? [] : ['irrelevant_presented']),
    ...(vector.duplicate.additionalPresented === 0 ? [] : ['duplicate_presented']),
    ...(vector.budget.presented === 0 && vector.budget.candidateEstimatedTokens > vector.budget.maxPromptTokens
      ? []
      : ['budget_not_enforced']),
    ...(vector.sourceCorrected.presented === 1 &&
    vector.sourceCorrected.drillStatus === 'not_available' &&
    vector.sourceCorrected.invalidationReason === 'source_corrected'
      ? []
      : ['corrected_source_drill_available']),
    ...(vector.sourceForgotten.presented === 1 &&
    vector.sourceForgotten.drillStatus === 'not_available' &&
    vector.sourceForgotten.invalidationReason === 'source_forgotten'
      ? []
      : ['forgotten_source_drill_available']),
    ...(vector.privateUnavailable.presented === 1 &&
    vector.privateUnavailable.drillStatus === 'not_available' &&
    vector.privateUnavailable.denialReason === 'scope_mismatch'
      ? []
      : ['private_drill_available']),
    ...(vector.crossOwner.presented === 0 ? [] : ['cross_owner_presented']),
    ...(vector.unknownEvent.presented === 0 ? [] : ['unknown_event_presented']),
  ];
}

async function replayFamily(family: EvaluatedFamily): Promise<F287MemoryCueFamilyReplayResult> {
  const relevant = await resolveOnce({ family, sourceState: 'relevant' });
  const irrelevant = await resolveOnce({ family, sourceState: 'irrelevant' });

  const duplicateInvocationState = { seenDedupeKeys: new Set<string>() };
  await resolveOnce({ family, sourceState: 'relevant', invocationState: duplicateInvocationState });
  const duplicate = await resolveOnce({ family, sourceState: 'relevant', invocationState: duplicateInvocationState });

  const budget = await resolveOnce({ family, sourceState: 'budget', oversizedHandle: true });
  const entry = getRecallOpportunityCatalogEntry(makeOpportunity(family));
  const sourceCorrected = await evaluateSourceLifecycle(family, 'source_corrected');
  const sourceForgotten = await evaluateSourceLifecycle(family, 'source_forgotten');
  const privateUnavailable = await evaluatePrivateDrill(family);
  const crossOwner = await resolveOnce({
    family,
    sourceState: 'relevant',
    candidate: makeOpportunity(family, { ...OWNER_SCOPE, ownerUserId: 'other-owner' }),
  });
  const unknownEvent = await resolveOnce({
    family,
    sourceState: 'relevant',
    candidate: { ...makeOpportunity(family), kind: 'unknown_event' },
  });

  const vector: F287MemoryCueConstraintVector = {
    relevant: { opportunities: 1, presented: relevant.cues.length },
    irrelevant: { opportunities: 1, presented: irrelevant.cues.length },
    duplicate: { replays: 1, additionalPresented: duplicate.cues.length },
    budget: {
      opportunities: 1,
      presented: budget.cues.length,
      maxPromptTokens: entry.maxPromptTokens,
      candidateEstimatedTokens: await estimateBudgetCandidateTokens(family),
    },
    sourceCorrected,
    sourceForgotten,
    privateUnavailable,
    crossOwner: { opportunities: 1, presented: crossOwner.cues.length },
    unknownEvent: { opportunities: 1, presented: unknownEvent.cues.length },
  };
  const hardConstraintFailures = findFailures(vector);
  return {
    family,
    verdict: hardConstraintFailures.length === 0 ? 'keep' : 'tune',
    verdictBasis: 'frozen_fixture_contract',
    vector,
    hardConstraintFailures,
  };
}

export async function runF287MemoryCueReplay(): Promise<F287MemoryCueReplayResult> {
  const families: F287MemoryCueFamilyReplayResult[] = [];
  for (const family of ['person_entity', 'operational_precedent', 'taste'] as const) {
    families.push(await replayFamily(family));
  }
  return {
    fixtureRevision: 'f287-memory-cue-eval-v1',
    catalogVersion: RECALL_OPPORTUNITY_CATALOG_VERSION,
    families,
  };
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  runF287MemoryCueReplay()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
}
