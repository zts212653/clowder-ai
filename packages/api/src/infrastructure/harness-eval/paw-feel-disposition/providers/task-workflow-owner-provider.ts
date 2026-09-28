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
import { queryTaskItems } from '../../../../domains/cats/services/stores/ports/TaskQuery.js';
import type { ITaskStore } from '../../../../domains/cats/services/stores/ports/TaskStore.js';
import type { IThreadStore } from '../../../../domains/cats/services/stores/ports/ThreadStore.js';
import { inspectPawFeelMessage } from '../../friction/paw-feel-source.js';
import type { PawFeelResolvedFix } from '../commands.js';
import type { PawFeelDirectRepairOwnerProvider } from '../direct-repair/direct-repair-federation.js';
import { PawFeelDirectRepairBindingV1Schema } from '../schema.js';
import {
  assertTaskWorkflowGitCommit,
  canonicalTaskWorkflowGitCommit,
  isTaskWorkflowFeatureFilterPath,
  type TaskWorkflowPawFeelGitTruth,
} from './task-workflow-git-truth.js';

const LIST_TASKS_TOOL_NAME = 'cat_cafe_list_tasks';
const LIST_TASKS_TOOL_REF = ownerTruthRefV1Schema.parse({
  ownerFeatureId: 'F160',
  ownerStateRef: `mcp-tool:${LIST_TASKS_TOOL_NAME}`,
});
const OWNER_CAT_ID = 'codex-sol';
const SOURCE_FEATURE_ID = 'F299';
const PROVIDER_VERSION = '1';
const SOURCE = Object.freeze({
  messageId: '0001788781516802-000382-1871ebdc',
  threadId: 'thread_mtgr1e6xdhvieto9',
  markerDigest: '826a137a03254e5934166baddb2e7fa5597542e77ce0cf8202367e1988daf70f',
  sameDigestOrdinal: 0,
  signalId: '0001788781516802-000382-1871ebdc:826a137a03254e5934166baddb2e7fa5597542e77ce0cf8202367e1988daf70f:0',
});
const AUTHORIZATION = Object.freeze({
  messageId: '0001788794400596-000676-4c986166',
  threadId: 'thread_mtr73addr1o2oncx',
  contentSha256: '17f4f0d6155f1ad100d3f32e67636c395143b9139d8f109e8e87c56f7606acb3',
});
const SOURCE_SIGNAL_REF = ownerTruthRefV1Schema.parse({
  ownerFeatureId: 'F278',
  ownerStateRef: `paw-feel-signal:${SOURCE.signalId}`,
  version: `${SOURCE.markerDigest}:${SOURCE.sameDigestOrdinal}`,
});
const RESOLVED_ACTION_REF = ownerTruthRefV1Schema.parse({
  ownerFeatureId: 'F160',
  ownerStateRef: 'task-action:list-feature-filter',
  version: PROVIDER_VERSION,
});
const ACTION_SCOPE_REF = ownerTruthRefV1Schema.parse({
  ownerFeatureId: 'F160',
  ownerStateRef: 'task-action-scope:list-feature-filter',
  version: PROVIDER_VERSION,
});
const OUTCOME_VERIFIER_REF = ownerTruthRefV1Schema.parse({
  ownerFeatureId: 'F160',
  ownerStateRef: 'task-outcome-verifier:feature-filter',
  version: PROVIDER_VERSION,
});

export const F160_LIST_TASKS_FEATURE_FILTER_REPAIR_ACTION = 'f160:list-tasks-feature-filter';

export const TASK_WORKFLOW_PAW_FEEL_PROVIDER_ROUTE: PawFeelDirectRepairOwnerRouteV1 = Object.freeze({
  schemaVersion: 1,
  providerId: 'f160-task-workflow-owner',
  providerVersion: '1',
  sourceToolRoutes: Object.freeze([
    Object.freeze({ ownerFeatureId: 'F160', ownerStateRef: 'mcp-tool:cat_cafe_list_tasks', match: 'exact' as const }),
  ]),
});

interface TaskWorkflowPawFeelDirectRepairOwnerProviderOptions {
  messageStore: Pick<IMessageStore, 'getById'>;
  taskStore: Pick<ITaskStore, 'get' | 'listByThread'>;
  threadStore: Pick<IThreadStore, 'list'>;
  ownerUserId: string;
  gitTruth: TaskWorkflowPawFeelGitTruth;
}

function sameRef(left: OwnerTruthRefV1, right: OwnerTruthRefV1): boolean {
  return refIdentity(left) === refIdentity(right);
}

function contentSha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function blockerRef(reason: string): OwnerTruthRefV1 {
  return ownerTruthRefV1Schema.parse({
    ownerFeatureId: 'F160',
    ownerStateRef: `task-workflow-direct-repair-blocker:${reason}`,
    version: PROVIDER_VERSION,
  });
}

export class TaskWorkflowPawFeelDirectRepairOwnerProvider implements PawFeelDirectRepairOwnerProvider {
  constructor(private readonly options: TaskWorkflowPawFeelDirectRepairOwnerProviderOptions) {
    if (!options.ownerUserId.trim()) throw new Error('task-workflow owner user must be non-empty');
  }

  async resolveAuthority(input: {
    source: VerifiedPawFeelDirectRepairSourceV1;
    custody: PawFeelResolvedFix;
    actionRef: string;
  }): Promise<PawFeelDirectRepairAuthorityDecisionV1> {
    if (
      !sameRef(input.source.sourceToolRef, LIST_TASKS_TOOL_REF) ||
      !sameRef(input.source.sourceSignalRef, SOURCE_SIGNAL_REF)
    ) {
      return { status: 'blocked', reason: 'action_source_mismatch', blockerRef: blockerRef('source-mismatch') };
    }
    if (input.actionRef !== F160_LIST_TASKS_FEATURE_FILTER_REPAIR_ACTION) {
      return { status: 'blocked', reason: 'action_not_found', blockerRef: blockerRef('action-not-found') };
    }
    if (input.custody.ownerCatId !== OWNER_CAT_ID) {
      return { status: 'blocked', reason: 'owner_mismatch', blockerRef: blockerRef('owner-mismatch') };
    }
    const { authorizationRef } = await this.readCanonicalSource();
    const custodyTask = await this.options.taskStore.get(input.custody.taskId);
    if (
      !custodyTask ||
      custodyTask.id !== input.custody.taskId ||
      custodyTask.ownerCatId !== OWNER_CAT_ID ||
      custodyTask.status === 'done'
    ) {
      return { status: 'blocked', reason: 'owner_mismatch', blockerRef: blockerRef('custody-mismatch') };
    }
    const targetRevision = canonicalTaskWorkflowGitCommit(this.options.gitTruth.loadedRevision);
    const mainRevision = canonicalTaskWorkflowGitCommit(await this.options.gitTruth.currentMainRevision());
    const targetIsOnMain =
      targetRevision !== null &&
      mainRevision !== null &&
      (await this.options.gitTruth.isAncestor(targetRevision, mainRevision));
    if (!targetIsOnMain) {
      return { status: 'blocked', reason: 'target_mismatch', blockerRef: blockerRef('target-mismatch') };
    }
    return {
      status: 'authorized',
      authority: {
        schemaVersion: 1,
        resolvedActionRef: RESOLVED_ACTION_REF,
        actionScopeRef: ACTION_SCOPE_REF,
        ownerAuthorizationRef: authorizationRef,
        targetVersionRef: exactAssetVersionRefV1Schema.parse({
          ...LIST_TASKS_TOOL_REF,
          version: targetRevision,
          assetKind: 'mcp_tool',
          assetId: LIST_TASKS_TOOL_NAME,
        }),
        ownerCatId: OWNER_CAT_ID,
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
    const { authorizationRef } = await this.readCanonicalSource();
    this.assertBinding(binding, authorizationRef);

    const baselineRevision = assertTaskWorkflowGitCommit(binding.targetVersionRef.version);
    const loadedRevision = canonicalTaskWorkflowGitCommit(this.options.gitTruth.loadedRevision);
    const mainRevision = canonicalTaskWorkflowGitCommit(await this.options.gitTruth.currentMainRevision());
    const hasNewLoadedRevision =
      loadedRevision !== null && mainRevision !== null && baselineRevision !== loadedRevision;
    if (!hasNewLoadedRevision) {
      throw new Error('task-workflow outcome has no newer loaded repair revision');
    }
    if (
      !(await this.options.gitTruth.isAncestor(baselineRevision, loadedRevision)) ||
      !(await this.options.gitTruth.isAncestor(loadedRevision, mainRevision))
    ) {
      throw new Error('task-workflow loaded repair is not on current main ancestry');
    }
    const changedFiles = [...new Set(await this.options.gitTruth.changedFiles(baselineRevision, loadedRevision))]
      .map((path) => path.trim())
      .filter(Boolean)
      .sort();
    const hasBoundedFeatureFilterDelta =
      changedFiles.length > 0 && changedFiles.length <= 200 && changedFiles.some(isTaskWorkflowFeatureFilterPath);
    if (!hasBoundedFeatureFilterDelta) {
      throw new Error('task-workflow outcome has no bounded feature-filter delta');
    }

    const threads = await this.options.threadStore.list(this.options.ownerUserId);
    const query = await queryTaskItems(this.options.taskStore, {
      threadIds: threads.map((thread) => thread.id),
      ownerUserId: this.options.ownerUserId,
      featureId: SOURCE_FEATURE_ID,
    });
    if (
      query.totalMatched === 0 ||
      query.truncated ||
      query.tasks.length !== query.totalMatched ||
      query.tasks.some((task) => task.relatedFeatureId !== SOURCE_FEATURE_ID) ||
      !query.queryRef ||
      !sameRef(query.queryRef, ownerOutcomeRef)
    ) {
      throw new Error('task-workflow owner outcome is stale, unbounded, or not the canonical filtered query');
    }

    const deltaDigest = contentSha256(JSON.stringify([baselineRevision, loadedRevision, changedFiles]));
    return {
      schemaVersion: 1,
      bindingRef: binding.bindingRef,
      taskTerminalRef: ownerTruthRefV1Schema.parse(input.taskTerminalRef),
      leaseTerminalRef: ownerTruthRefV1Schema.parse(input.leaseTerminalRef),
      ownerOutcomeRef,
      verificationRefs: [
        authorizationRef,
        SOURCE_SIGNAL_REF,
        query.queryRef,
        ownerTruthRefV1Schema.parse({
          ownerFeatureId: 'F160',
          ownerStateRef: `loaded-runtime:${loadedRevision}`,
          version: loadedRevision,
        }),
        ownerTruthRefV1Schema.parse({
          ownerFeatureId: 'F160',
          ownerStateRef: `git-main:${mainRevision}`,
          version: mainRevision,
        }),
        ownerTruthRefV1Schema.parse({
          ownerFeatureId: 'F160',
          ownerStateRef: `task-workflow-owner-delta:sha256:${deltaDigest}`,
          version: `${baselineRevision}..${loadedRevision}`,
        }),
      ],
      disposition: 'verified_changed',
    };
  }

  private async readCanonicalSource(): Promise<{ authorizationRef: OwnerTruthRefV1 }> {
    let sourceMessage: StoredMessage | null;
    let authorizationMessage: StoredMessage | null;
    try {
      [sourceMessage, authorizationMessage] = await Promise.all([
        this.options.messageStore.getById(SOURCE.messageId),
        this.options.messageStore.getById(AUTHORIZATION.messageId),
      ]);
    } catch (error) {
      throw new Error(`task-workflow source or authorization is unreadable: ${String(error)}`);
    }
    if (
      !sourceMessage ||
      sourceMessage.id !== SOURCE.messageId ||
      sourceMessage.threadId !== SOURCE.threadId ||
      sourceMessage.userId !== this.options.ownerUserId ||
      sourceMessage.catId !== OWNER_CAT_ID
    ) {
      throw new Error('task-workflow canonical source identity changed');
    }
    const inspection = inspectPawFeelMessage(sourceMessage);
    const candidate =
      inspection.kind === 'canonical'
        ? inspection.candidates.find(
            (entry) =>
              entry.signalId === SOURCE.signalId &&
              entry.markerDigest === SOURCE.markerDigest &&
              entry.sameDigestOrdinal === SOURCE.sameDigestOrdinal &&
              entry.marker.tool === LIST_TASKS_TOOL_NAME,
          )
        : undefined;
    if (!candidate) throw new Error('task-workflow canonical source marker digest or tool route changed');
    if (
      !authorizationMessage ||
      authorizationMessage.id !== AUTHORIZATION.messageId ||
      authorizationMessage.threadId !== AUTHORIZATION.threadId ||
      authorizationMessage.userId !== this.options.ownerUserId ||
      authorizationMessage.catId !== null ||
      contentSha256(authorizationMessage.content) !== AUTHORIZATION.contentSha256
    ) {
      throw new Error('task-workflow operator authorization identity or content digest changed');
    }
    return {
      authorizationRef: ownerTruthRefV1Schema.parse({
        ownerFeatureId: 'F313',
        ownerStateRef: `cvo-authorization:${AUTHORIZATION.messageId}`,
        version: `sha256:${AUTHORIZATION.contentSha256}`,
      }),
    };
  }

  private assertBinding(binding: PawFeelDirectRepairBindingV1, authorizationRef: OwnerTruthRefV1): void {
    if (
      binding.providerId !== TASK_WORKFLOW_PAW_FEEL_PROVIDER_ROUTE.providerId ||
      binding.providerVersion !== TASK_WORKFLOW_PAW_FEEL_PROVIDER_ROUTE.providerVersion ||
      binding.ownerCatId !== OWNER_CAT_ID ||
      !sameRef(binding.sourceSignalRef, SOURCE_SIGNAL_REF) ||
      !sameRef(binding.sourceToolRef, LIST_TASKS_TOOL_REF) ||
      !sameRef(binding.resolvedActionRef, RESOLVED_ACTION_REF) ||
      !sameRef(binding.actionScopeRef, ACTION_SCOPE_REF) ||
      !sameRef(binding.ownerAuthorizationRef, authorizationRef) ||
      !sameRef(binding.outcomeVerifierRef, OUTCOME_VERIFIER_REF) ||
      binding.targetVersionRef.assetKind !== 'mcp_tool' ||
      binding.targetVersionRef.assetId !== LIST_TASKS_TOOL_NAME ||
      binding.targetVersionRef.ownerFeatureId !== LIST_TASKS_TOOL_REF.ownerFeatureId ||
      binding.targetVersionRef.ownerStateRef !== LIST_TASKS_TOOL_REF.ownerStateRef
    ) {
      throw new Error('task-workflow direct-repair binding no longer matches canonical owner truth');
    }
  }
}
