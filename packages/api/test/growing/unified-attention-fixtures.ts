import type { ApprovalHubItem, ApprovalProducerId } from '@cat-cafe/shared';

export function approval(id: string, feature: ApprovalProducerId = 'F221', revision = 10): ApprovalHubItem {
  return {
    proposalId: id,
    sourceFeatureId: feature,
    requesterCatId: 'opus',
    ownerUserId: 'owner',
    summary: `Choose ${id}`,
    detail: {},
    navigation: { state: 'legacy_unanchored' },
    inlineApprovable: false,
    resolution: 'open',
    materialization: { state: 'not_started' },
    createdAt: revision,
  };
}
export function work(receipts: ReturnType<typeof receipt>[]) {
  return {
    envelope: {
      subjectRef: 'task:work:one',
      revision: 3,
      freshness: { state: 'current', observedRevision: 3 },
      visibility: { ownerUserId: 'owner' },
    },
    brief: { outcome: { state: 'known', value: 'Decide the result' }, current: { state: 'doing' } },
    work: { threadId: 'original-thread' },
    preparedArtifact: {
      artifactRef: 'artifact:one',
      artifactRevision: 'v1',
      completenessRef: 'complete:one',
      previewRef: 'preview:one',
      openInWorkspaceRef: 'workspace:one',
    },
    attentionReceipts: receipts,
  };
}
export function receipt(id: string, producerId = 'f306.runtime_interaction', revision = 20) {
  return {
    eligible: true,
    kind: 'judgment',
    recommendation: `Choose ${id}`,
    reasonCode: 'choose',
    producer: { producerId, subjectRef: id, revision },
    taskRef: { subjectRef: 'task:work:one', observedRevision: 3 },
    action: { actionRef: `message:original-thread:${id}#card`, expectedProducerRevision: revision },
    reEvaluateActionRef: `${id}#reevaluate`,
  };
}
