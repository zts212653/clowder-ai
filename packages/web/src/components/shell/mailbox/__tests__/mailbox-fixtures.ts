import type {
  ApprovalHubItem,
  EntrustedWorkOwnerReadV1,
  UnifiedAttentionItemV1,
  UnifiedAttentionReadV1,
} from '@cat-cafe/shared';
import { anchoredApprovalNavigation } from '@/test-support/approval-navigation';
import type { MailboxRead } from '../../unified-mailbox-state';

/** Shared fixtures for the mailbox's approval modules: one owner, one generic approval, reads that list or omit it. */
export const OWNER = 'owner-1';
export const NOW = 1_000_000;

export function storeItem(overrides: Partial<ApprovalHubItem> = {}): ApprovalHubItem {
  return {
    navigation: anchoredApprovalNavigation('thread-src'),
    requesterCatId: 'opus',
    resolution: 'open',
    materialization: { state: 'not_started' },
    createdAt: 500_000,
    ownerUserId: OWNER,
    proposalId: 'p-1',
    sourceFeatureId: 'F128',
    summary: 'New thread: 记一条品味',
    detail: {},
    inlineApprovable: true,
    ...overrides,
  };
}

/** What the unified read carries for an approval: the Hub's item without its owner (the read's identity carries that). */
export function visibleApproval(item: ApprovalHubItem): Omit<ApprovalHubItem, 'ownerUserId'> {
  return Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'ownerUserId')) as Omit<
    ApprovalHubItem,
    'ownerUserId'
  >;
}

export function approvalRow(
  item: ApprovalHubItem,
  decisionRef = `approval:${item.proposalId}`,
): UnifiedAttentionItemV1 {
  return { decisionRef, kind: 'approval', summary: item.summary, approval: visibleApproval(item), linkedNeedsMe: [] };
}

export function collectiveResultRow(): UnifiedAttentionItemV1 {
  const producerSubjectRef = 'collective-result:con_aaaaaaaa:work_aaaaaaaa';
  const taskSubjectRef = 'task:work:collective-result';
  const taskOwnerRef = 'task:item:collective-result';
  const evidence = [{ producerId: 'f290.collective_work_result' as const, ownerRef: producerSubjectRef, revision: 4 }];
  const ownerRead: EntrustedWorkOwnerReadV1 = {
    envelope: {
      subjectRef: taskSubjectRef,
      ownerRef: taskOwnerRef,
      admissionReceiptRef: 'task:receipt:collective-result',
      sourceRefs: ['message:collective-source'],
      revision: 8,
      freshness: { state: 'current', observedRevision: 8 },
      visibility: { ownerUserId: OWNER, human: true, cat: true },
    },
    brief: {
      outcome: { state: 'known', value: 'Review the Collective result', ownerRef: taskOwnerRef, revision: 8 },
      current: { state: 'doing', ownerRef: taskOwnerRef, revision: 8 },
      verifiedMilestone: { kind: 'needs_judgment', evidenceRef: producerSubjectRef, revision: 4 },
      nextOwner: { kind: 'human', ownerRef: `user:${OWNER}`, evidence },
      needsMe: { state: 'needed', evidence },
    },
    work: {
      title: 'Prepare the Collective result',
      ownerCatId: 'codex-sol',
      threadId: 'thread-private',
      admittedAt: 1,
      ownerNote: '',
    },
    preparedArtifact: {
      artifactRef: 'artifact:result',
      artifactRevision: '1',
      completenessRef: 'artifact:result#complete:1',
      previewRef: 'artifact:result#preview:1',
      openInWorkspaceRef: 'workspace:artifact:thread-private:1:artifact:result',
    },
    timeRefs: [],
    attentionReceipts: [
      {
        eligible: true,
        producer: {
          producerId: 'f290.collective_work_result',
          ownerRef: producerSubjectRef,
          subjectRef: producerSubjectRef,
          revision: 4,
        },
        taskRef: { subjectRef: taskSubjectRef, observedRevision: 8 },
        kind: 'judgment',
        reasonCode: 'collective_result_ready',
        recommendation: 'Review the prepared result in its Collective Work',
        salience: 'normal',
        action: {
          actionRef:
            '/collective?connectionId=con_aaaaaaaa&workId=work_aaaaaaaa&workRevision=4&channelId=general&resultEventId=evt_result0000&resultRevision=2',
          expectedProducerRevision: 4,
        },
        reEvaluateActionRef: `${producerSubjectRef}#reevaluate`,
      },
    ],
  };
  const receipt = ownerRead.attentionReceipts[0];
  if (!receipt?.eligible) throw new Error('collective result fixture must expose its exact eligible receipt');
  return {
    decisionRef: `f290.collective_work_result:${producerSubjectRef}`,
    kind: 'judgment',
    summary: receipt.recommendation,
    linkedNeedsMe: [{ ownerRead, receipt }],
  };
}

/** An available, complete, verified read of one owner's page. */
export function okRead(items: UnifiedAttentionItemV1[], overrides: Partial<UnifiedAttentionReadV1> = {}): MailboxRead {
  const source = {
    status: 'available' as const,
    startedAt: 1,
    observedAt: 2,
    coverage: 'all_registered_F246_producers' as const,
    exhaustiveness: 'complete' as const,
  };
  const read: UnifiedAttentionReadV1 = {
    version: 1,
    status: 'available',
    scope: 'owner_all_projects',
    identity: { ownerUserId: OWNER },
    observedAt: 2,
    sources: {
      approvals: source,
      needsMe: { ...source, coverage: 'current_linked_F310_five_producers' },
    },
    readWindow: { startedAt: 1, endedAt: 2, consistency: 'independent_source_reads' },
    consistency: { state: 'verified', reasons: [] },
    items,
    totalCount: items.length,
    page: { offset: 0, limit: 20, scope: 'known_rows', hasMore: false },
    ...overrides,
  };
  return { kind: 'ok', read };
}
