import { createHash } from 'node:crypto';
import {
  type CueEnvelopeV1,
  cueEnvelopeV1Schema,
  RECALL_OPPORTUNITY_CATALOG_VERSION,
  type RecallOpportunityV1,
  type RecallResolverFamily,
  type RecallScopeV1,
} from '@cat-cafe/shared';
import { formatMemoryCues } from './format-memory-cues.js';
import type { MemoryCueEventInput } from './MemoryCueEpisodeStore.js';
import type { CreateMemoryCueDrillHandleInput, MemoryCueResolverRegistry } from './MemoryCueResolverRegistry.js';
import { RECALL_RESOLVER_ADMISSION_V1 } from './MemoryCueResolverRegistry.js';
import {
  admitRecallOpportunity,
  getRecallOpportunityCatalogEntry,
  type RecallOpportunityCatalogEntry,
} from './RecallOpportunityCatalog.js';

export interface MemoryCueInvocationState {
  readonly seenDedupeKeys: Set<string>;
}

export type MemoryCueResolutionStatus = 'not_admitted' | 'expired' | 'duplicate' | 'admitted';

export interface MemoryCueResolution {
  status: MemoryCueResolutionStatus;
  cues: CueEnvelopeV1[];
  promptSegment: string;
  estimatedTokens: number;
}

export interface ResolveMemoryCueInput {
  candidate: unknown;
  serverScope: RecallScopeV1;
  invocationState: MemoryCueInvocationState;
  now: number;
  createDrillHandle(input: CreateMemoryCueDrillHandleInput): string;
}

const ZERO_RESULT: Omit<MemoryCueResolution, 'status'> = Object.freeze({
  cues: [],
  promptSegment: '',
  estimatedTokens: 0,
});

function sameScope(left: RecallScopeV1, right: RecallScopeV1): boolean {
  return (
    left.ownerUserId === right.ownerUserId &&
    left.threadId === right.threadId &&
    left.invocationId === right.invocationId
  );
}

export class MemoryCuePlaneService {
  constructor(
    private readonly registry: MemoryCueResolverRegistry,
    private readonly episodeStore?: { append(event: MemoryCueEventInput): unknown },
  ) {}

  async resolve(input: ResolveMemoryCueInput): Promise<MemoryCueResolution> {
    const opportunity = admitRecallOpportunity(input.candidate, input.serverScope);
    if (!opportunity) return { status: 'not_admitted', ...ZERO_RESULT };

    const entry = getRecallOpportunityCatalogEntry(opportunity);
    const expiresAt = opportunity.occurredAt + entry.expiresAfterMs;
    if (input.now >= expiresAt) return { status: 'expired', ...ZERO_RESULT };

    const dedupeKey = entry.dedupeKey(opportunity);
    if (input.invocationState.seenDedupeKeys.has(dedupeKey)) {
      return { status: 'duplicate', ...ZERO_RESULT };
    }
    input.invocationState.seenDedupeKeys.add(dedupeKey);

    const candidates = await this.collectCandidates(opportunity, entry, expiresAt, input);
    const formatted = formatMemoryCues(candidates, { maxTokens: entry.maxPromptTokens });
    for (const cue of formatted.cues) this.appendPresented(opportunity.occurredAt, cue);
    return {
      status: 'admitted',
      cues: formatted.cues,
      promptSegment: formatted.text,
      estimatedTokens: formatted.estimatedTokens,
    };
  }

  private async collectCandidates(
    opportunity: RecallOpportunityV1,
    entry: RecallOpportunityCatalogEntry,
    expiresAt: number,
    input: ResolveMemoryCueInput,
  ): Promise<CueEnvelopeV1[]> {
    const candidates: CueEnvelopeV1[] = [];
    for (const family of entry.resolverFamilies) {
      if (RECALL_RESOLVER_ADMISSION_V1[family] !== 'catalog') continue;
      candidates.push(...(await this.resolveFamily(opportunity, family, expiresAt, input)));
    }
    return candidates.slice(0, entry.maxCues);
  }

  private async resolveFamily(
    opportunity: RecallOpportunityV1,
    family: RecallResolverFamily,
    expiresAt: number,
    input: ResolveMemoryCueInput,
  ): Promise<CueEnvelopeV1[]> {
    let resolved: readonly CueEnvelopeV1[];
    try {
      resolved = await this.registry.get(family).resolve(opportunity, {
        now: input.now,
        expiresAt,
        createDrillHandle: input.createDrillHandle,
      });
    } catch {
      return [];
    }
    return resolved.flatMap((candidate) => {
      const parsed = cueEnvelopeV1Schema.safeParse(candidate);
      if (!parsed.success) return [];
      const cue = parsed.data;
      return this.isValidCue(cue, opportunity, family, expiresAt, input.serverScope) ? [cue] : [];
    });
  }

  private isValidCue(
    cue: CueEnvelopeV1,
    opportunity: RecallOpportunityV1,
    family: RecallResolverFamily,
    expiresAt: number,
    serverScope: RecallScopeV1,
  ): boolean {
    return (
      cue.opportunityId === opportunity.opportunityId &&
      cue.catalogVersion === RECALL_OPPORTUNITY_CATALOG_VERSION &&
      cue.resolverFamily === family &&
      cue.expiresAt === expiresAt &&
      sameScope(cue.scope, serverScope)
    );
  }

  private appendPresented(opportunityOccurredAt: number, cue: CueEnvelopeV1): void {
    if (!this.episodeStore) return;
    const digest = createHash('sha256')
      .update(['presented', cue.cueId, cue.scope.invocationId].join('\0'))
      .digest('hex')
      .slice(0, 40);
    this.episodeStore.append({
      eventId: `memory-cue-presented-${digest}`,
      idempotencyKey: `memory-cue-presented-${digest}`,
      cueId: cue.cueId,
      opportunityId: cue.opportunityId,
      scope: cue.scope,
      resolverFamily: cue.resolverFamily,
      sourceAnchor: cue.source.anchor,
      sourceRevision: cue.source.revision,
      axis: 'consumption',
      consumptionOutcome: 'presented',
      catalogVersion: cue.catalogVersion,
      resolverVersion: cue.resolverVersion,
      occurredAt: opportunityOccurredAt,
    });
  }
}
