import { createHash } from 'node:crypto';
import {
  exactAssetVersionRefV1Schema,
  type OwnerTruthRefV1,
  ownerTruthRefV1Schema,
  type PawFeelDirectRepairAuthorityDecisionV1,
  type PawFeelDirectRepairBindingV1,
  type PawFeelDirectRepairOutcomeV1,
  type PawFeelDirectRepairOwnerRouteV1,
  refIdentity,
  type VerifiedPawFeelDirectRepairSourceV1,
} from '@cat-cafe/shared';
import type { IMessageStore, StoredMessage } from '../../../../domains/cats/services/stores/ports/MessageStore.js';
import type { MemoryCueEpisodeStore } from '../../../../domains/memory/cue/MemoryCueEpisodeStore.js';
import type { PawFeelResolvedFix } from '../commands.js';
import type { PawFeelDirectRepairOwnerProvider } from '../direct-repair/direct-repair-federation.js';
import { PawFeelDirectRepairBindingV1Schema } from '../schema.js';
import {
  assertMemoryCueGitCommit,
  canonicalMemoryCueGitCommit,
  isMemoryCueOutcomeLifecyclePath,
  type MemoryCuePawFeelGitTruth,
} from './memory-cue-git-truth.js';

const MEMORY_CUE_TOOL_NAME = 'cat_cafe_record_memory_cue_outcome';
const MEMORY_CUE_TOOL_REF = ownerTruthRefV1Schema.parse({
  ownerFeatureId: 'F287',
  ownerStateRef: `mcp-tool:${MEMORY_CUE_TOOL_NAME}`,
});
const F287_OWNER_CAT_ID = 'codex-sol';
const PROVIDER_VERSION = '1';
const AUTHORIZATION = Object.freeze({
  messageId: '0001788794400596-000676-4c986166',
  threadId: 'thread_mtr73addr1o2oncx',
  contentSha256: '17f4f0d6155f1ad100d3f32e67636c395143b9139d8f109e8e87c56f7606acb3',
});

export const F287_MEMORY_CUE_OUTCOME_REPAIR_ACTION = 'f287:memory-cue-outcome-lifecycle';

export const MEMORY_CUE_PAW_FEEL_PROVIDER_ROUTE: PawFeelDirectRepairOwnerRouteV1 = Object.freeze({
  schemaVersion: 1,
  providerId: 'f287-memory-cue-owner',
  providerVersion: PROVIDER_VERSION,
  sourceToolRoutes: Object.freeze([Object.freeze({ ...MEMORY_CUE_TOOL_REF, match: 'exact' as const })]),
});

const RESOLVED_ACTION_REF = ownerTruthRefV1Schema.parse({
  ownerFeatureId: 'F287',
  ownerStateRef: 'memory-cue-action:outcome-lifecycle',
  version: PROVIDER_VERSION,
});
const ACTION_SCOPE_REF = ownerTruthRefV1Schema.parse({
  ownerFeatureId: 'F287',
  ownerStateRef: 'memory-cue-action-scope:outcome-lifecycle',
  version: PROVIDER_VERSION,
});
const OUTCOME_VERIFIER_REF = ownerTruthRefV1Schema.parse({
  ownerFeatureId: 'F287',
  ownerStateRef: 'memory-cue-outcome-verifier:merged-loaded',
  version: PROVIDER_VERSION,
});

interface MemoryCuePawFeelDirectRepairOwnerProviderOptions {
  messageStore: Pick<IMessageStore, 'getById'>;
  episodeStore: Pick<MemoryCueEpisodeStore, 'getByEventId'>;
  ownerUserId: string;
  loadedAtMs: number;
  gitTruth: MemoryCuePawFeelGitTruth;
}

function sameRef(left: OwnerTruthRefV1, right: OwnerTruthRefV1): boolean {
  return refIdentity(left) === refIdentity(right);
}

function contentSha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function blockerRef(reason: string): OwnerTruthRefV1 {
  return ownerTruthRefV1Schema.parse({
    ownerFeatureId: 'F287',
    ownerStateRef: `memory-cue-direct-repair-blocker:${reason}`,
    version: PROVIDER_VERSION,
  });
}

export class MemoryCuePawFeelDirectRepairOwnerProvider implements PawFeelDirectRepairOwnerProvider {
  constructor(private readonly options: MemoryCuePawFeelDirectRepairOwnerProviderOptions) {
    if (!options.ownerUserId.trim()) throw new Error('memory-cue owner user must be non-empty');
    if (!Number.isSafeInteger(options.loadedAtMs) || options.loadedAtMs < 0) {
      throw new Error('memory-cue loadedAtMs must be a non-negative integer');
    }
  }

  async resolveAuthority(input: {
    source: VerifiedPawFeelDirectRepairSourceV1;
    custody: PawFeelResolvedFix;
    actionRef: string;
  }): Promise<PawFeelDirectRepairAuthorityDecisionV1> {
    if (!sameRef(input.source.sourceToolRef, MEMORY_CUE_TOOL_REF)) {
      return { status: 'blocked', reason: 'action_source_mismatch', blockerRef: blockerRef('source-mismatch') };
    }
    if (input.actionRef !== F287_MEMORY_CUE_OUTCOME_REPAIR_ACTION) {
      return { status: 'blocked', reason: 'action_not_found', blockerRef: blockerRef('action-not-found') };
    }
    if (input.custody.ownerCatId !== F287_OWNER_CAT_ID) {
      return { status: 'blocked', reason: 'owner_mismatch', blockerRef: blockerRef('owner-mismatch') };
    }
    const ownerAuthorizationRef = await this.readAuthorizationRef();
    const targetRevision = canonicalMemoryCueGitCommit(this.options.gitTruth.loadedRevision);
    const mainRevision = canonicalMemoryCueGitCommit(await this.options.gitTruth.currentMainRevision());
    if (!targetRevision || !mainRevision || !(await this.options.gitTruth.isAncestor(targetRevision, mainRevision))) {
      return { status: 'blocked', reason: 'target_mismatch', blockerRef: blockerRef('target-mismatch') };
    }
    return {
      status: 'authorized',
      authority: {
        schemaVersion: 1,
        resolvedActionRef: RESOLVED_ACTION_REF,
        actionScopeRef: ACTION_SCOPE_REF,
        ownerAuthorizationRef,
        targetVersionRef: exactAssetVersionRefV1Schema.parse({
          ...MEMORY_CUE_TOOL_REF,
          version: targetRevision,
          assetKind: 'mcp_tool',
          assetId: MEMORY_CUE_TOOL_NAME,
        }),
        ownerCatId: F287_OWNER_CAT_ID,
        outcomeVerifierRef: OUTCOME_VERIFIER_REF,
      },
    };
  }

  async verifyOutcome(input: {
    binding: PawFeelDirectRepairBindingV1;
    ownerOutcomeRef: OwnerTruthRefV1;
    taskTerminalRef: OwnerTruthRefV1;
    leaseTerminalRef: OwnerTruthRefV1;
  }): Promise<PawFeelDirectRepairOutcomeV1> {
    const binding = PawFeelDirectRepairBindingV1Schema.parse(input.binding);
    const ownerOutcomeRef = ownerTruthRefV1Schema.parse(input.ownerOutcomeRef);
    const ownerAuthorizationRef = await this.readAuthorizationRef();
    this.assertBinding(binding, ownerAuthorizationRef);

    const baselineRevision = assertMemoryCueGitCommit(binding.targetVersionRef.version);
    const loadedRevision = canonicalMemoryCueGitCommit(this.options.gitTruth.loadedRevision);
    const mainRevision = canonicalMemoryCueGitCommit(await this.options.gitTruth.currentMainRevision());
    if (!loadedRevision || !mainRevision || baselineRevision === loadedRevision) {
      throw new Error('memory-cue outcome has no newer loaded repair revision');
    }
    if (
      !(await this.options.gitTruth.isAncestor(baselineRevision, loadedRevision)) ||
      !(await this.options.gitTruth.isAncestor(loadedRevision, mainRevision))
    ) {
      throw new Error('memory-cue loaded repair is not on the current main ancestry');
    }
    const changedFiles = [...new Set(await this.options.gitTruth.changedFiles(baselineRevision, loadedRevision))]
      .map((path) => path.trim())
      .filter(Boolean)
      .sort();
    if (changedFiles.length === 0 || changedFiles.length > 200 || !changedFiles.some(isMemoryCueOutcomeLifecyclePath)) {
      throw new Error('memory-cue outcome has no bounded outcome-lifecycle delta');
    }

    const eventId = ownerOutcomeRef.ownerStateRef.startsWith('memory-cue-consumption:')
      ? ownerOutcomeRef.ownerStateRef.slice('memory-cue-consumption:'.length)
      : '';
    const event = eventId ? this.options.episodeStore.getByEventId(eventId) : null;
    if (
      !event ||
      event.eventId !== eventId ||
      event.axis !== 'consumption' ||
      (event.consumptionOutcome !== 'applied' && event.consumptionOutcome !== 'dismissed') ||
      event.consumerCatId !== F287_OWNER_CAT_ID ||
      event.scope.ownerUserId !== this.options.ownerUserId ||
      event.createdAt !== ownerOutcomeRef.version ||
      event.occurredAt < this.options.loadedAtMs ||
      !Number.isFinite(Date.parse(event.createdAt)) ||
      Date.parse(event.createdAt) < this.options.loadedAtMs
    ) {
      throw new Error('memory-cue owner outcome event is missing, stale, or belongs to another owner');
    }

    const deltaDigest = contentSha256(JSON.stringify([baselineRevision, loadedRevision, changedFiles]));
    return {
      schemaVersion: 1,
      bindingRef: binding.bindingRef,
      taskTerminalRef: ownerTruthRefV1Schema.parse(input.taskTerminalRef),
      leaseTerminalRef: ownerTruthRefV1Schema.parse(input.leaseTerminalRef),
      ownerOutcomeRef,
      verificationRefs: [
        ownerAuthorizationRef,
        ownerOutcomeRef,
        ownerTruthRefV1Schema.parse({
          ownerFeatureId: 'F287',
          ownerStateRef: `loaded-runtime:${loadedRevision}`,
          version: loadedRevision,
        }),
        ownerTruthRefV1Schema.parse({
          ownerFeatureId: 'F287',
          ownerStateRef: `git-main:${mainRevision}`,
          version: mainRevision,
        }),
        ownerTruthRefV1Schema.parse({
          ownerFeatureId: 'F287',
          ownerStateRef: `memory-cue-owner-delta:sha256:${deltaDigest}`,
          version: `${baselineRevision}..${loadedRevision}`,
        }),
      ],
      disposition: 'verified_changed',
    };
  }

  private async readAuthorizationRef(): Promise<OwnerTruthRefV1> {
    let message: StoredMessage | null;
    try {
      message = await this.options.messageStore.getById(AUTHORIZATION.messageId);
    } catch (error) {
      throw new Error(`memory-cue operator authorization is unreadable: ${String(error)}`);
    }
    if (
      !message ||
      message.id !== AUTHORIZATION.messageId ||
      message.threadId !== AUTHORIZATION.threadId ||
      message.userId !== this.options.ownerUserId ||
      message.catId !== null ||
      contentSha256(message.content) !== AUTHORIZATION.contentSha256
    ) {
      throw new Error('memory-cue operator authorization identity or content digest changed');
    }
    return ownerTruthRefV1Schema.parse({
      ownerFeatureId: 'F313',
      ownerStateRef: `cvo-authorization:${AUTHORIZATION.messageId}`,
      version: `sha256:${AUTHORIZATION.contentSha256}`,
    });
  }

  private assertBinding(binding: PawFeelDirectRepairBindingV1, authorizationRef: OwnerTruthRefV1): void {
    if (
      binding.providerId !== MEMORY_CUE_PAW_FEEL_PROVIDER_ROUTE.providerId ||
      binding.providerVersion !== MEMORY_CUE_PAW_FEEL_PROVIDER_ROUTE.providerVersion ||
      binding.ownerCatId !== F287_OWNER_CAT_ID ||
      !sameRef(binding.sourceToolRef, MEMORY_CUE_TOOL_REF) ||
      !sameRef(binding.resolvedActionRef, RESOLVED_ACTION_REF) ||
      !sameRef(binding.actionScopeRef, ACTION_SCOPE_REF) ||
      !sameRef(binding.ownerAuthorizationRef, authorizationRef) ||
      !sameRef(binding.outcomeVerifierRef, OUTCOME_VERIFIER_REF) ||
      binding.targetVersionRef.assetKind !== 'mcp_tool' ||
      binding.targetVersionRef.assetId !== MEMORY_CUE_TOOL_NAME ||
      binding.targetVersionRef.ownerFeatureId !== MEMORY_CUE_TOOL_REF.ownerFeatureId ||
      binding.targetVersionRef.ownerStateRef !== MEMORY_CUE_TOOL_REF.ownerStateRef
    ) {
      throw new Error('memory-cue direct-repair binding no longer matches canonical owner truth');
    }
  }
}
