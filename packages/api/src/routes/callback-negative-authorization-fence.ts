import { createHash } from 'node:crypto';
import type { ActionSuccessorRequestMetadata, CatId } from '@cat-cafe/shared';
import type { FastifyBaseLogger } from 'fastify';
import type {
  DispatchNegativeAuthorizationBlock,
  IDispatchProposalStore,
} from '../domains/approval-hub/stores/ports/IDispatchProposalStore.js';
import {
  tryCanonicalizeDispatchAdmissionSubjectRef,
  tryComputeDispatchCanonicalActionKey,
} from '../domains/approval-hub/stores/ports/IDispatchProposalStore.js';
import { analyzeA2AMentions } from '../domains/cats/services/agents/routing/a2a-mentions.js';
import { resolveCatTarget } from '../domains/cats/services/agents/routing/cat-target-resolver.js';
import { extractRichFromText } from '../domains/cats/services/agents/routing/rich-block-extract.js';
import { type EventAuditLog, getEventAuditLog } from '../domains/cats/services/orchestration/EventAuditLog.js';

/**
 * Mirrors normal callback target resolution before any admission side effect.
 * The result is only used to decide whether to deny the whole carrier.
 */
function resolveCanonicalCarrierTargets(input: {
  content: string;
  isCrossThread: boolean;
  senderCatId: CatId;
  explicitTargetCats?: readonly string[];
  actionCarrier: boolean;
  suppressRouting: boolean;
}): string[] {
  const storedContent = extractRichFromText(input.content).cleanText;
  const contentAnalysis = analyzeA2AMentions(storedContent, input.isCrossThread ? undefined : input.senderCatId);
  const contentTargets = input.actionCarrier ? [] : contentAnalysis.mentions;
  const validExplicitTargets: string[] = [];
  for (const target of input.explicitTargetCats ?? []) {
    const resolved = resolveCatTarget(target);
    if ('ok' in resolved) validExplicitTargets.push(resolved.ok);
  }
  const mergedTargets = new Set<string>([...contentTargets, ...validExplicitTargets]);
  if (contentTargets.length === 1 && mergedTargets.size > 1) {
    const [primaryTarget] = contentTargets;
    if (primaryTarget) return input.suppressRouting ? [] : [primaryTarget];
  }
  return input.suppressRouting ? [] : [...mergedTargets];
}

/**
 * Only a transition carrying a persisted F167 lease reference can bypass a
 * first-claim admission check. `existing_standing` names the issuer's proof,
 * not an already-claimed lease, so it still needs canonical admission.
 */
export function isPersistedActionSuccessorTransition(action: unknown): boolean {
  if (!action || typeof action !== 'object') return false;
  const candidate = action as {
    replace?: unknown;
    returnToPredecessor?: unknown;
  };
  return Boolean(candidate.replace || candidate.returnToPredecessor);
}

/**
 * A structured carrier proves the complete F167 identity. An actionless
 * coordination carrier proves no action identity at all, so its subject can
 * only nominate a held action for denial; it cannot grant or synthesize
 * custody from a partial key.
 */
function resolveCanonicalAdmissionCandidate(input: {
  ownerUserId: string;
  action?: ActionSuccessorRequestMetadata;
  coordinationSubjectRef?: string;
}): { canonicalActionKey?: string; canonicalSubjectRef?: string } | undefined {
  if (input.action) {
    const canonicalActionKey = tryComputeDispatchCanonicalActionKey(input.ownerUserId, input.action);
    // Let F167 return its ordinary invalid-action response. Never degrade a
    // malformed structured action into a weaker subject-only lookup.
    return canonicalActionKey ? { canonicalActionKey } : undefined;
  }
  if (!input.coordinationSubjectRef) return undefined;
  const canonicalSubjectRef = tryCanonicalizeDispatchAdmissionSubjectRef(input.coordinationSubjectRef);
  // An opaque coordination subject does not identify an executable action.
  return canonicalSubjectRef ? { canonicalSubjectRef } : undefined;
}

function mergeNegativeAuthorizationBlocks(
  blocks: readonly DispatchNegativeAuthorizationBlock[],
): DispatchNegativeAuthorizationBlock[] {
  const byProposalId = new Map<string, DispatchNegativeAuthorizationBlock>();
  for (const block of blocks) {
    const existing = byProposalId.get(block.proposalId);
    if (!existing) {
      byProposalId.set(block.proposalId, { ...block, targetCats: [...block.targetCats] });
      continue;
    }
    for (const targetCat of block.targetCats) {
      if (!existing.targetCats.includes(targetCat)) existing.targetCats.push(targetCat);
    }
    existing.targetCats.sort();
  }
  return [...byProposalId.values()].sort((left, right) => left.proposalId.localeCompare(right.proposalId));
}

export type NegativeAuthorizationFenceResult =
  | {
      statusCode: 409;
      body: {
        kind: 'dispatch_negative_authorization_blocked' | 'legacy_dispatch_lineage_unresolved';
        proposalIds: string[];
        blockedTargetCats: string[];
      };
    }
  | {
      statusCode: 503;
      body: { error: string; code: 'DISPATCH_NEGATIVE_AUTHORIZATION_UNAVAILABLE' };
    };

export interface NegativeAuthorizationFenceInput {
  content: string;
  isCrossThread: boolean;
  effectClass?: string;
  senderCatId: CatId;
  sourceThreadId: string;
  sourceInvocationId: string;
  sourceInvocationCreatedAt: number;
  targetThreadId: string;
  ownerUserId: string;
  explicitTargetCats?: readonly string[];
  action?: ActionSuccessorRequestMetadata;
  coordinationSubjectRef?: string;
  suppressRouting: boolean;
  clientMessageId?: string;
  dispatchProposalStore?: IDispatchProposalStore;
  /** Redis F167 owns full-key structured admission; broad preflight remains for actionless/non-atomic carriers. */
  deferStructuredActionAdmissionToAtomicClaim?: boolean;
  eventAuditLog?: Pick<EventAuditLog, 'append'>;
  log: Pick<FastifyBaseLogger, 'error'>;
}

export interface DispatchNegativeAuthorizationAuditInput {
  proposalStatuses: ReadonlyArray<{
    proposalId: string;
    status: DispatchNegativeAuthorizationBlock['status'];
  }>;
  sourceInvocationId: string;
  sourceThreadId: string;
  targetThreadId: string;
  senderCatId: CatId;
  blockedTargetCats: readonly string[];
  effectClass?: string;
  clientMessageId?: string;
  legacyCutoverAt?: number;
  legacyUnresolved?: boolean;
  eventAuditLog?: Pick<EventAuditLog, 'append'>;
  log: Pick<FastifyBaseLogger, 'error'>;
}

export async function appendDispatchNegativeAuthorizationBlockedAudit(
  input: DispatchNegativeAuthorizationAuditInput,
): Promise<void> {
  const proposalIds = input.proposalStatuses.map(({ proposalId }) => proposalId);
  const auditData = {
    proposalIds,
    proposalStatuses: input.proposalStatuses,
    sourceInvocationId: input.sourceInvocationId,
    sourceThreadId: input.sourceThreadId,
    targetThreadId: input.targetThreadId,
    senderCatId: input.senderCatId,
    blockedTargetCats: [...input.blockedTargetCats].sort(),
    effectClass: input.effectClass ?? 'omitted',
    clientMessageIdPresent: Boolean(input.clientMessageId),
    ...(input.legacyCutoverAt !== undefined ? { legacyCutoverAt: input.legacyCutoverAt } : {}),
    legacyUnresolved: input.legacyUnresolved ?? false,
    ...(input.clientMessageId
      ? { clientMessageIdHash: createHash('sha256').update(input.clientMessageId).digest('hex') }
      : {}),
  };
  try {
    await (input.eventAuditLog ?? getEventAuditLog()).append({
      type: 'dispatch_negative_authorization_blocked',
      threadId: input.targetThreadId,
      data: auditData,
    });
  } catch (err) {
    input.log.error(
      { err, proposalIds, sourceInvocationId: input.sourceInvocationId },
      '[F246/#1291] negative authorization audit append failed',
    );
  }
}

/**
 * #1291 admission fence. It runs before freshness, F167, dedup, rich-buffer
 * consumption, message persistence, and queue admission. The projection can
 * only deny; every candidate is revalidated by the canonical proposal store.
 */
export async function preflightNegativeAuthorizationFence(
  input: NegativeAuthorizationFenceInput,
): Promise<NegativeAuthorizationFenceResult | undefined> {
  const canonicalCarrierTargets = resolveCanonicalCarrierTargets({
    content: input.content,
    isCrossThread: input.isCrossThread,
    senderCatId: input.senderCatId,
    explicitTargetCats: input.explicitTargetCats,
    actionCarrier: Boolean(input.action),
    suppressRouting: input.suppressRouting,
  });
  if (
    !input.isCrossThread ||
    input.effectClass === 'assign_work' ||
    canonicalCarrierTargets.length === 0 ||
    !input.dispatchProposalStore ||
    isPersistedActionSuccessorTransition(input.action)
  ) {
    return undefined;
  }

  // Exact and legacy proposal indexes are intentionally broader than a full
  // action identity. For an atomic structured carrier, F167 resolves an
  // existing lease before its broad lineage and full-key canonical deny
  // checks; applying the lineage-wide preflight here would let an unrelated
  // proposal preempt a valid replay or re-entry.
  if (input.action && input.deferStructuredActionAdmissionToAtomicClaim) return undefined;

  const canonicalAdmissionCandidate = resolveCanonicalAdmissionCandidate({
    ownerUserId: input.ownerUserId,
    ...(input.action ? { action: input.action } : {}),
    ...(input.coordinationSubjectRef ? { coordinationSubjectRef: input.coordinationSubjectRef } : {}),
  });
  let negativeAuthorizationBlocks: DispatchNegativeAuthorizationBlock[];
  let legacyCutoverAt: number | undefined;
  let legacyProposalIds = new Set<string>();
  let nonLegacyProposalIds = new Set<string>();
  try {
    const exactBlocks = await input.dispatchProposalStore.findNegativeAuthorizationBlocks({
      ownerUserId: input.ownerUserId,
      sourceInvocationId: input.sourceInvocationId,
      sourceThreadId: input.sourceThreadId,
      senderCatId: input.senderCatId,
      targetThreadId: input.targetThreadId,
      targetCats: canonicalCarrierTargets,
    });
    legacyCutoverAt = await input.dispatchProposalStore.getNegativeAuthorizationLegacyCutoverAt();
    const legacyBlocks =
      legacyCutoverAt !== undefined && input.sourceInvocationCreatedAt <= legacyCutoverAt
        ? await input.dispatchProposalStore.findLegacyNegativeAuthorizationBlocks({
            ownerUserId: input.ownerUserId,
            sourceThreadId: input.sourceThreadId,
            senderCatId: input.senderCatId,
            targetThreadId: input.targetThreadId,
            targetCats: canonicalCarrierTargets,
            invocationCreatedAt: input.sourceInvocationCreatedAt,
            cutoverAt: legacyCutoverAt,
          })
        : [];
    const canonicalBlocks = canonicalAdmissionCandidate
      ? await input.dispatchProposalStore.findCanonicalAdmissionBlocks({
          ownerUserId: input.ownerUserId,
          ...canonicalAdmissionCandidate,
        })
      : [];
    legacyProposalIds = new Set(legacyBlocks.map((block) => block.proposalId));
    nonLegacyProposalIds = new Set([
      ...exactBlocks.map((block) => block.proposalId),
      ...canonicalBlocks.map((block) => block.proposalId),
    ]);
    negativeAuthorizationBlocks = mergeNegativeAuthorizationBlocks([
      ...exactBlocks,
      ...legacyBlocks,
      ...canonicalBlocks.map((block) => ({
        ...block,
        // Canonical identity is tenant-scoped rather than target-scoped. Once
        // it matches, the entire incoming carrier is denied before routing.
        targetCats: [...canonicalCarrierTargets],
      })),
    ]);
  } catch (err) {
    input.log.error(
      {
        err,
        sourceInvocationId: input.sourceInvocationId,
        sourceThreadId: input.sourceThreadId,
        targetThreadId: input.targetThreadId,
      },
      '[F246/#1291] negative authorization lookup unavailable',
    );
    return {
      statusCode: 503,
      body: {
        error: 'Dispatch authorization guard unavailable; retry shortly',
        code: 'DISPATCH_NEGATIVE_AUTHORIZATION_UNAVAILABLE',
      },
    };
  }

  if (negativeAuthorizationBlocks.length === 0) return undefined;

  const proposalIds = negativeAuthorizationBlocks.map((block) => block.proposalId);
  const blockedTargetCats = [...new Set(negativeAuthorizationBlocks.flatMap((block) => block.targetCats))].sort();
  await appendDispatchNegativeAuthorizationBlockedAudit({
    proposalStatuses: negativeAuthorizationBlocks.map((block) => ({
      proposalId: block.proposalId,
      status: block.status,
    })),
    sourceInvocationId: input.sourceInvocationId,
    sourceThreadId: input.sourceThreadId,
    targetThreadId: input.targetThreadId,
    senderCatId: input.senderCatId,
    blockedTargetCats,
    effectClass: input.effectClass,
    clientMessageId: input.clientMessageId,
    ...(legacyCutoverAt !== undefined ? { legacyCutoverAt } : {}),
    legacyUnresolved: legacyProposalIds.size > 0,
    eventAuditLog: input.eventAuditLog,
    log: input.log,
  });
  return {
    statusCode: 409,
    body: {
      kind: negativeAuthorizationBlocks.every(
        (block) => legacyProposalIds.has(block.proposalId) && !nonLegacyProposalIds.has(block.proposalId),
      )
        ? 'legacy_dispatch_lineage_unresolved'
        : 'dispatch_negative_authorization_blocked',
      proposalIds,
      blockedTargetCats,
    },
  };
}
