import { createHash } from 'node:crypto';
import type { CatId } from '@cat-cafe/shared';
import type { FastifyBaseLogger } from 'fastify';
import type {
  DispatchNegativeAuthorizationBlock,
  IDispatchProposalStore,
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

function isExistingActionSuccessorTransition(action: unknown): boolean {
  if (!action || typeof action !== 'object') return false;
  const candidate = action as {
    replace?: unknown;
    returnToPredecessor?: unknown;
    reviewReentry?: unknown;
    claimOrigin?: unknown;
  };
  return Boolean(
    candidate.replace ||
      candidate.returnToPredecessor ||
      candidate.reviewReentry ||
      candidate.claimOrigin === 'existing_standing',
  );
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
  action?: unknown;
  suppressRouting: boolean;
  clientMessageId?: string;
  dispatchProposalStore?: IDispatchProposalStore;
  eventAuditLog?: Pick<EventAuditLog, 'append'>;
  log: Pick<FastifyBaseLogger, 'error'>;
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
    isExistingActionSuccessorTransition(input.action)
  ) {
    return undefined;
  }

  let negativeAuthorizationBlocks: DispatchNegativeAuthorizationBlock[];
  let legacyCutoverAt: number | undefined;
  let legacyNegativeAuthorizationBlockCount = 0;
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
    legacyNegativeAuthorizationBlockCount = legacyBlocks.length;
    negativeAuthorizationBlocks = [...exactBlocks, ...legacyBlocks].sort((left, right) =>
      left.proposalId.localeCompare(right.proposalId),
    );
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
  const auditData = {
    proposalIds,
    proposalStatuses: negativeAuthorizationBlocks.map((block) => ({
      proposalId: block.proposalId,
      status: block.status,
    })),
    sourceInvocationId: input.sourceInvocationId,
    sourceThreadId: input.sourceThreadId,
    targetThreadId: input.targetThreadId,
    senderCatId: input.senderCatId,
    blockedTargetCats,
    effectClass: input.effectClass ?? 'omitted',
    clientMessageIdPresent: Boolean(input.clientMessageId),
    ...(legacyCutoverAt !== undefined ? { legacyCutoverAt } : {}),
    legacyUnresolved: legacyNegativeAuthorizationBlockCount > 0,
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
  return {
    statusCode: 409,
    body: {
      kind:
        negativeAuthorizationBlocks.length === legacyNegativeAuthorizationBlockCount
          ? 'legacy_dispatch_lineage_unresolved'
          : 'dispatch_negative_authorization_blocked',
      proposalIds,
      blockedTargetCats,
    },
  };
}
