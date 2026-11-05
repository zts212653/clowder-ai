import { createHash } from 'node:crypto';
import type {
  AcceptedDecisionRequiredOpportunityV1,
  ApprovedTasteInvokedOpportunityV1,
  AuthorizedTaskSourcesOpportunityV1,
  DeliveryDecisionOpportunityV1,
  FreshContextSourcesOpportunityV1,
  JudgmentSurfaceEnteredOpportunityV1,
  OwnedSeedAvailableOpportunityV1,
  ProfileRevisionAvailableOpportunityV1,
  ProjectSourceRequiredOpportunityV1,
  RecallOpportunityV1,
  RecallScopeV1,
  RecentEventAvailableOpportunityV1,
  SubjectSeenOpportunityV1,
  ThreadOpenedOpportunityV1,
} from '@cat-cafe/shared';
import { contextEpochScopeKey } from '../../cats/services/session/context/ContextEpochOwner.js';
import type { NativeProfileOpeningDelivery } from '../profile/native-profile-opening.js';
import { ContextSourceWorkBudget } from './ContextSourceWorkBudget.js';
import type { ContextSourceOmission } from './context-source-omission.js';
import type {
  MemoryCueDeliveryConfirmation,
  MemoryCueDeliveryReceipt,
  MemoryCuePlaneService,
  MemoryCuePresentationEnvelope,
} from './MemoryCuePlaneService.js';
import type { CreateMemoryCueDrillHandleInput } from './MemoryCueResolverRegistry.js';
import type { MemoryCueSourceReader } from './MemoryCueSourceReader.js';

export type MemoryCueOpportunitySeed =
  | {
      kind: 'fresh_context_sources';
      producer: 'context_epoch';
      occurredAt: number;
      payload: FreshContextSourcesOpportunityV1['payload'];
    }
  | {
      kind: 'authorized_task_sources';
      producer: 'task_action_custody';
      occurredAt: number;
      payload: AuthorizedTaskSourcesOpportunityV1['payload'];
    }
  | {
      kind: 'thread_opened';
      producer: 'owner_message';
      occurredAt: number;
      payload: ThreadOpenedOpportunityV1['payload'];
    }
  | {
      kind: 'subject_seen';
      producer: 'entity_nudge';
      occurredAt: number;
      payload: SubjectSeenOpportunityV1['payload'];
    }
  | {
      kind: 'delivery_decision';
      producer: 'github_ci';
      occurredAt: number;
      payload: DeliveryDecisionOpportunityV1['payload'];
    }
  | {
      kind: 'judgment_surface_entered';
      producer: 'workflow_sop';
      occurredAt: number;
      payload: JudgmentSurfaceEnteredOpportunityV1['payload'];
    }
  | {
      kind: 'approved_taste_invoked';
      producer: 'owner_message';
      occurredAt: number;
      payload: ApprovedTasteInvokedOpportunityV1['payload'];
    }
  | {
      kind: 'profile_revision_available';
      producer: 'profile_repository';
      occurredAt: number;
      payload: ProfileRevisionAvailableOpportunityV1['payload'];
    }
  | {
      kind: 'recent_event_available';
      producer: 'event_memory';
      occurredAt: number;
      payload: RecentEventAvailableOpportunityV1['payload'];
    }
  | {
      kind: 'accepted_decision_required';
      producer: 'owner_message';
      occurredAt: number;
      payload: AcceptedDecisionRequiredOpportunityV1['payload'];
    }
  | {
      kind: 'project_source_required';
      producer: 'task_context';
      occurredAt: number;
      payload: ProjectSourceRequiredOpportunityV1['payload'];
    }
  | {
      kind: 'owned_seed_available';
      producer: 'present_loop';
      occurredAt: number;
      payload: OwnedSeedAvailableOpportunityV1['payload'];
    };

export interface ResolveMemoryCueInvocationPromptInput {
  seeds: readonly MemoryCueOpportunitySeed[];
  serverScope: RecallScopeV1;
  now: number;
  consumerCatId: string;
  signal?: AbortSignal;
  contextSourceBudget?: ContextSourceWorkBudget;
}

export interface MemoryCueInvocationPromptResolution {
  promptSegment: string;
  admittedOpportunityIds: readonly string[];
  omittedOpportunityIds: readonly string[];
  deliveryReceipts: readonly MemoryCueDeliveryReceipt[];
  presentationEnvelopes: readonly MemoryCuePresentationEnvelope[];
}

export interface MemoryCueInvocationPromptResolver {
  recordProfileOpeningObserved?(delivery: NativeProfileOpeningDelivery): Promise<void>;
  resolve(input: ResolveMemoryCueInvocationPromptInput): Promise<MemoryCueInvocationPromptResolution>;
  recordPresented?(
    receipts: readonly MemoryCueDeliveryReceipt[],
    confirmation: MemoryCueDeliveryConfirmation,
  ): Promise<void>;
}

export function memoryCueOpportunityId(
  seed: MemoryCueOpportunitySeed,
  scope: RecallScopeV1,
  consumerCatId?: string,
): string {
  const contextSource = seed.kind === 'fresh_context_sources' || seed.kind === 'authorized_task_sources';
  const identity = contextSource
    ? [
        seed.kind,
        contextEpochScopeKey({ userId: scope.ownerUserId, catId: consumerCatId ?? '', threadId: scope.threadId }),
        seed.payload.contextEpoch,
        JSON.stringify(seed.payload.evidence),
        seed.payload.sourceMessageId,
      ]
    : [seed.kind, seed.producer, scope.threadId, JSON.stringify(seed.payload)];
  const digest = createHash('sha256').update(identity.join('\0')).digest('hex').slice(0, 40);
  return `memory-cue-opportunity-${digest}`;
}

function bindSeed(seed: MemoryCueOpportunitySeed, scope: RecallScopeV1, consumerCatId: string): RecallOpportunityV1 {
  const base = {
    v: 1 as const,
    opportunityId: memoryCueOpportunityId(seed, scope, consumerCatId),
    consumer: 'agent_route' as const,
    scope,
    occurredAt: seed.occurredAt,
  };
  switch (seed.kind) {
    case 'fresh_context_sources':
      return { ...base, kind: seed.kind, producer: seed.producer, payload: seed.payload };
    case 'authorized_task_sources':
      return { ...base, kind: seed.kind, producer: seed.producer, payload: seed.payload };
    case 'thread_opened':
      return { ...base, kind: seed.kind, producer: seed.producer, payload: seed.payload };
    case 'subject_seen':
      return { ...base, kind: seed.kind, producer: seed.producer, payload: seed.payload };
    case 'delivery_decision':
      return { ...base, kind: seed.kind, producer: seed.producer, payload: seed.payload };
    case 'judgment_surface_entered':
      return { ...base, kind: seed.kind, producer: seed.producer, payload: seed.payload };
    case 'approved_taste_invoked':
      return { ...base, kind: seed.kind, producer: seed.producer, payload: seed.payload };
    case 'profile_revision_available':
      return { ...base, kind: seed.kind, producer: seed.producer, payload: seed.payload };
    case 'recent_event_available':
      return { ...base, kind: seed.kind, producer: seed.producer, payload: seed.payload };
    case 'accepted_decision_required':
      return { ...base, kind: seed.kind, producer: seed.producer, payload: seed.payload };
    case 'project_source_required':
      return { ...base, kind: seed.kind, producer: seed.producer, payload: seed.payload };
    case 'owned_seed_available':
      return { ...base, kind: seed.kind, producer: seed.producer, payload: seed.payload };
  }
}

/**
 * Invocation-bound adapter between server-owned producer seeds and the Cue Plane.
 * Route strategies never invent invocation ids: they carry scope-free seeds until
 * invokeSingleCat has created the callback-authenticated child invocation.
 */
export class MemoryCueInvocationPromptService implements MemoryCueInvocationPromptResolver {
  constructor(
    private readonly deps: {
      plane: MemoryCuePlaneService;
      recordProfileOpeningObserved?(delivery: NativeProfileOpeningDelivery): void;
      sourceReader?: MemoryCueSourceReader;
      validateContextSource?(
        opportunityId: string,
        scope: RecallScopeV1,
        consumerCatId: string,
        now: number,
      ): Promise<boolean>;
      recordOmission?(opportunityId: string, reason: ContextSourceOmission): void;
      onProviderCommitted?(
        receipts: readonly MemoryCueDeliveryReceipt[],
        confirmation: MemoryCueDeliveryConfirmation,
      ): void;
      createDrillHandle(input: CreateMemoryCueDrillHandleInput): string;
    },
  ) {}

  async resolve(input: ResolveMemoryCueInvocationPromptInput): Promise<MemoryCueInvocationPromptResolution> {
    const invocationState = { seenDedupeKeys: new Set<string>() };
    const segments: string[] = [];
    const admittedOpportunityIds: string[] = [];
    const omittedOpportunityIds: string[] = [];
    const deliveryReceipts: MemoryCueDeliveryReceipt[] = [];
    const presentationEnvelopes: MemoryCuePresentationEnvelope[] = [];
    const budget = input.contextSourceBudget ?? new ContextSourceWorkBudget();
    for (const seed of input.seeds) {
      input.signal?.throwIfAborted();
      const candidate = bindSeed(seed, input.serverScope, input.consumerCatId);
      const contextSource = seed.kind === 'fresh_context_sources' || seed.kind === 'authorized_task_sources';
      const recordOmission = (reason: ContextSourceOmission) =>
        this.deps.recordOmission?.(candidate.opportunityId, reason);
      const resolve = (signal?: AbortSignal) =>
        this.deps.plane.resolve({
          candidate,
          serverScope: input.serverScope,
          invocationState,
          now: input.now,
          consumerCatId: input.consumerCatId,
          signal: signal ?? input.signal,
          recordOmission,
          ...(contextSource ? { contextSourceBudget: budget } : {}),
          createDrillHandle: (coordinate) => this.deps.createDrillHandle(coordinate),
        });
      let resolved;
      try {
        resolved = await resolve();
      } catch (error) {
        if (!contextSource || input.signal?.aborted) throw error;
        recordOmission('timeout');
        omittedOpportunityIds.push(candidate.opportunityId);
        continue;
      }
      input.signal?.throwIfAborted();
      if (resolved.promptSegment) {
        segments.push(resolved.promptSegment);
        admittedOpportunityIds.push(candidate.opportunityId);
        deliveryReceipts.push(...resolved.deliveryReceipts);
        presentationEnvelopes.push(
          ...resolved.presentationEnvelopes.map((envelope) => {
            if (!contextSource) return envelope;
            let invalid = false;
            return {
              ...envelope,
              recordOmission,
              validateCurrent: async () => {
                if (invalid) return false;
                try {
                  const current = await budget.run(async () => {
                    if (
                      !this.deps.validateContextSource ||
                      !(await this.deps.validateContextSource(
                        candidate.opportunityId,
                        input.serverScope,
                        input.consumerCatId,
                        Date.now(),
                      ))
                    ) {
                      recordOmission('scope_revoked');
                      return false;
                    }
                    const read = await this.deps.sourceReader?.read({
                      opportunityId: candidate.opportunityId,
                      family: envelope.receipt.event.resolverFamily === 'profile' ? 'profile' : 'evidence',
                      anchor: envelope.receipt.event.sourceAnchor,
                      expectedRevision: envelope.receipt.event.sourceRevision,
                      scope: input.serverScope,
                      consumerCatId: input.consumerCatId,
                    });
                    if (read?.status !== 'ok') {
                      recordOmission(read?.invalidationReason ?? 'source_unavailable');
                      return false;
                    }
                    return true;
                  });
                  if (!current) invalid = true;
                  return current;
                } catch {
                  invalid = true;
                  recordOmission('timeout');
                  return false;
                }
              },
            };
          }),
        );
      } else {
        omittedOpportunityIds.push(candidate.opportunityId);
      }
    }
    return {
      promptSegment: segments.join('\n\n'),
      admittedOpportunityIds,
      omittedOpportunityIds,
      deliveryReceipts,
      presentationEnvelopes,
    };
  }

  async recordPresented(
    receipts: readonly MemoryCueDeliveryReceipt[],
    confirmation: MemoryCueDeliveryConfirmation,
  ): Promise<void> {
    await this.deps.plane.recordPresented(receipts, confirmation);
    this.deps.onProviderCommitted?.(receipts, confirmation);
  }

  async recordProfileOpeningObserved(delivery: NativeProfileOpeningDelivery): Promise<void> {
    this.deps.recordProfileOpeningObserved?.(delivery);
  }
}
