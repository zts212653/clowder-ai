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
  taskFeatureIdSchema,
  type VerifiedPawFeelDirectRepairSourceV1,
} from '@cat-cafe/shared';
import type { IMessageStore, StoredMessage } from '../../../../domains/cats/services/stores/ports/MessageStore.js';
import { queryTaskItems } from '../../../../domains/cats/services/stores/ports/TaskQuery.js';
import type { ITaskStore } from '../../../../domains/cats/services/stores/ports/TaskStore.js';
import type { IThreadStore } from '../../../../domains/cats/services/stores/ports/ThreadStore.js';
import type { PawFeelResolvedFix } from '../commands.js';
import type { PawFeelDirectRepairOwnerProvider } from '../direct-repair/direct-repair-federation.js';
import { PawFeelDirectRepairBindingV1Schema } from '../schema.js';
import { verifyPawFeelOwnerRepairGitProof } from './owner-repair-git-proof.js';
import {
  assertTaskWorkflowGitCommit,
  canonicalTaskWorkflowGitCommit,
  isTaskWorkflowFeatureFilterPath,
  type TaskWorkflowPawFeelGitTruth,
} from './task-workflow-git-truth.js';
import { resolveTaskWorkflowRepairScope } from './task-workflow-repair-scope.js';

const LIST_TASKS_TOOL_NAME = 'cat_cafe_list_tasks';
const LIST_TASKS_TOOL_REF = ownerTruthRefV1Schema.parse({
  ownerFeatureId: 'F160',
  ownerStateRef: `mcp-tool:${LIST_TASKS_TOOL_NAME}`,
});
const OWNER_CAT_ID = 'codex-sol';
const PROVIDER_VERSION = '1';
const AUTHORIZATION = Object.freeze({
  messageId: '0001788794400596-000676-4c986166',
  threadId: 'thread_mtr73addr1o2oncx',
  contentSha256: '17f4f0d6155f1ad100d3f32e67636c395143b9139d8f109e8e87c56f7606acb3',
});
const RESOLVED_ACTION_REF = ownerTruthRefV1Schema.parse({
  ownerFeatureId: 'F160',
  ownerStateRef: 'task-action:list-feature-filter',
  version: PROVIDER_VERSION,
});
const OUTCOME_VERIFIER_REF = ownerTruthRefV1Schema.parse({
  ownerFeatureId: 'F160',
  ownerStateRef: 'task-outcome-verifier:feature-filter',
  version: PROVIDER_VERSION,
});

export {
  F160_LIST_TASKS_FEATURE_FILTER_REPAIR_ACTION,
  f160ListTasksFeatureFilterRepairAction,
} from './task-workflow-repair-scope.js';

export const TASK_WORKFLOW_PAW_FEEL_PROVIDER_ROUTE: PawFeelDirectRepairOwnerRouteV1 = Object.freeze({
  schemaVersion: 1,
  providerId: 'f160-task-workflow-owner',
  providerVersion: PROVIDER_VERSION,
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

function featureIdFromQueryRef(ref: OwnerTruthRefV1): string {
  const canonicalOwner = ref.ownerFeatureId === 'F160' && ref.version === '1';
  if (!canonicalOwner) {
    throw new Error('task-workflow owner outcome is not a canonical feature query ref');
  }
  const match = /^task-query:feature:([^:]+):sha256:[a-f0-9]{64}$/u.exec(ref.ownerStateRef);
  if (!match?.[1]) throw new Error('task-workflow owner outcome is not a canonical feature query ref');
  return taskFeatureIdSchema.parse(match[1]);
}

function featureActionScopeRef(featureId: string): OwnerTruthRefV1 {
  return ownerTruthRefV1Schema.parse({
    ownerFeatureId: 'F160',
    ownerStateRef: `task-action-scope:list-feature-filter:feature:${taskFeatureIdSchema.parse(featureId)}`,
    version: PROVIDER_VERSION,
  });
}

function featureIdFromActionScopeRef(ref: OwnerTruthRefV1): string {
  const canonicalOwner = ref.ownerFeatureId === 'F160' && ref.version === PROVIDER_VERSION;
  if (!canonicalOwner) {
    throw new Error('task-workflow binding has no canonical feature-query scope');
  }
  const match = /^task-action-scope:list-feature-filter:feature:(F\d+)$/u.exec(ref.ownerStateRef);
  if (!match?.[1]) throw new Error('task-workflow binding has no canonical feature-query scope');
  return taskFeatureIdSchema.parse(match[1]);
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
    if (!sameRef(input.source.sourceToolRef, LIST_TASKS_TOOL_REF)) {
      return { status: 'blocked', reason: 'action_source_mismatch', blockerRef: blockerRef('source-mismatch') };
    }
    const scope = await resolveTaskWorkflowRepairScope({
      actionRef: input.actionRef,
      source: input.source,
      messageStore: this.options.messageStore,
      ownerUserId: this.options.ownerUserId,
    });
    if (scope.status === 'invalid_action') {
      return { status: 'blocked', reason: 'action_not_found', blockerRef: blockerRef('action-not-found') };
    }
    if (input.custody.ownerCatId !== OWNER_CAT_ID) {
      return { status: 'blocked', reason: 'owner_mismatch', blockerRef: blockerRef('owner-mismatch') };
    }
    if (scope.status === 'source_scope_unproven') {
      return { status: 'blocked', reason: 'action_source_mismatch', blockerRef: blockerRef('source-scope') };
    }
    const authorizationRef = await this.readAuthorizationRef();
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
        actionScopeRef: featureActionScopeRef(scope.featureId),
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
    const authorizationRef = await this.readAuthorizationRef();
    const featureId = this.assertBinding(binding, authorizationRef);

    const baselineRevision = assertTaskWorkflowGitCommit(binding.targetVersionRef.version);
    const loadedRevision = canonicalTaskWorkflowGitCommit(this.options.gitTruth.loadedRevision);
    const mainRevision = canonicalTaskWorkflowGitCommit(await this.options.gitTruth.currentMainRevision());
    const gitProof = await verifyPawFeelOwnerRepairGitProof({
      label: 'task-workflow',
      baselineRevision,
      loadedRevision,
      mainRevision,
      gitTruth: this.options.gitTruth,
      isRelevantPath: isTaskWorkflowFeatureFilterPath,
    });

    if (featureIdFromQueryRef(ownerOutcomeRef) !== featureId) {
      throw new Error('task-workflow owner outcome does not match the source-bound feature scope');
    }
    const threads = await this.options.threadStore.list(this.options.ownerUserId);
    const query = await queryTaskItems(this.options.taskStore, {
      threadIds: threads.map((thread) => thread.id),
      ownerUserId: this.options.ownerUserId,
      featureId,
    });
    if (
      query.truncated ||
      query.tasks.length !== query.totalMatched ||
      query.tasks.some((task) => task.relatedFeatureId !== featureId) ||
      !query.queryRef ||
      !sameRef(query.queryRef, ownerOutcomeRef)
    ) {
      throw new Error('task-workflow owner outcome is stale, unbounded, or not the canonical filtered query');
    }

    const proofDigest = contentSha256(
      JSON.stringify([gitProof.mode, baselineRevision, loadedRevision, gitProof.changedFiles]),
    );
    return {
      schemaVersion: 1,
      bindingRef: binding.bindingRef,
      taskTerminalRef: ownerTruthRefV1Schema.parse(input.taskTerminalRef),
      leaseTerminalRef: ownerTruthRefV1Schema.parse(input.leaseTerminalRef),
      ownerOutcomeRef,
      verificationRefs: [
        authorizationRef,
        binding.sourceSignalRef,
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
          ownerStateRef: `task-workflow-owner-proof:sha256:${proofDigest}`,
          version: `${gitProof.mode}:${baselineRevision}..${loadedRevision}`,
        }),
      ],
      disposition: 'verified_changed',
    };
  }

  private async readAuthorizationRef(): Promise<OwnerTruthRefV1> {
    let authorizationMessage: StoredMessage | null;
    try {
      authorizationMessage = await this.options.messageStore.getById(AUTHORIZATION.messageId);
    } catch (error) {
      throw new Error(`task-workflow authorization is unreadable: ${String(error)}`);
    }
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
    return ownerTruthRefV1Schema.parse({
      ownerFeatureId: 'F313',
      ownerStateRef: `cvo-authorization:${AUTHORIZATION.messageId}`,
      version: `sha256:${AUTHORIZATION.contentSha256}`,
    });
  }

  private assertBinding(binding: PawFeelDirectRepairBindingV1, authorizationRef: OwnerTruthRefV1): string {
    const featureId = featureIdFromActionScopeRef(binding.actionScopeRef);
    if (
      binding.providerId !== TASK_WORKFLOW_PAW_FEEL_PROVIDER_ROUTE.providerId ||
      binding.providerVersion !== TASK_WORKFLOW_PAW_FEEL_PROVIDER_ROUTE.providerVersion ||
      binding.ownerCatId !== OWNER_CAT_ID ||
      binding.sourceSignalRef.ownerFeatureId !== 'F278' ||
      !binding.sourceSignalRef.ownerStateRef.startsWith('paw-feel-signal:') ||
      !sameRef(binding.sourceToolRef, LIST_TASKS_TOOL_REF) ||
      !sameRef(binding.resolvedActionRef, RESOLVED_ACTION_REF) ||
      !sameRef(binding.ownerAuthorizationRef, authorizationRef) ||
      !sameRef(binding.outcomeVerifierRef, OUTCOME_VERIFIER_REF) ||
      binding.targetVersionRef.assetKind !== 'mcp_tool' ||
      binding.targetVersionRef.assetId !== LIST_TASKS_TOOL_NAME ||
      binding.targetVersionRef.ownerFeatureId !== LIST_TASKS_TOOL_REF.ownerFeatureId ||
      binding.targetVersionRef.ownerStateRef !== LIST_TASKS_TOOL_REF.ownerStateRef
    ) {
      throw new Error('task-workflow direct-repair binding no longer matches canonical owner truth');
    }
    return featureId;
  }
}
