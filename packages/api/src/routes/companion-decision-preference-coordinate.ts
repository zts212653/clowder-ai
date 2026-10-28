import { createHash } from 'node:crypto';
import type { UnifiedAttentionItemV1, UnifiedAttentionPreferenceCoordinate } from '@cat-cafe/shared';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function exactVersionPayload(item: UnifiedAttentionItemV1): unknown | null {
  if (item.userMention) return userMentionVersionPayload(item.userMention);
  if (item.collectiveProjectAttention) {
    const value = item.collectiveProjectAttention;
    return {
      kind: 'collective_project_attention',
      producerId: value.producerId,
      subjectRef: value.subjectRef,
      revision: value.expectedProducerRevision,
      count: value.count,
    };
  }
  if (item.collectiveAccountabilityRequest) {
    const request = item.collectiveAccountabilityRequest;
    return {
      kind: 'collective_accountability_request',
      producerId: request.producerId,
      subjectRef: request.subjectRef,
      workRevision: request.workRevision,
      status: request.status,
    };
  }
  if (item.choiceRequest && legacyQuestionProjectionMatches(item)) {
    return {
      kind: 'structured_choice',
      interactionId: item.choiceRequest.interactionId,
      revision: item.choiceRequest.revision,
      cardRef: item.choiceRequest.cardRef,
    };
  }
  if (item.runtimeInteraction) {
    return {
      kind: 'runtime_interaction',
      runtimeInteraction: {
        interactionId: item.runtimeInteraction.interactionId,
        revision: item.runtimeInteraction.revision,
        kind: item.runtimeInteraction.kind,
        cardRef: item.runtimeInteraction.cardRef,
      },
      ...(item.approval ? { approval: item.approval } : {}),
      ...(item.originalApprovalCard ? { originalApprovalCard: item.originalApprovalCard } : {}),
    };
  }
  if (item.choiceRequest) {
    return {
      kind: 'structured_choice',
      interactionId: item.choiceRequest.interactionId,
      revision: item.choiceRequest.revision,
      cardRef: item.choiceRequest.cardRef,
    };
  }
  if (item.approval) {
    return {
      kind: 'approval',
      approval: item.approval,
      ...(item.originalApprovalCard ? { originalApprovalCard: item.originalApprovalCard } : {}),
    };
  }
  return receiptVersionPayload(item);
}

function receiptVersionPayload(item: UnifiedAttentionItemV1): unknown | null {
  if (item.linkedNeedsMe.length === 0) return null;
  const receipts = item.linkedNeedsMe
    .map(({ ownerRead, receipt }) => {
      const base = {
        ownerSubjectRef: ownerRead.envelope.subjectRef,
        ownerRevision: ownerRead.envelope.revision,
        producer: receipt.producer,
        taskRef: receipt.taskRef,
        kind: receipt.kind,
        action: receipt.action,
      };
      return receipt.producer.producerId === 'f309.content_review'
        ? {
            ...base,
            reasonCode: receipt.reasonCode,
            salience: receipt.salience,
            reEvaluateActionRef: receipt.reEvaluateActionRef,
          }
        : base;
    })
    .sort((left, right) => canonical(left).localeCompare(canonical(right)));
  return { kind: item.kind, receipts };
}

function userMentionVersionPayload(userMention: NonNullable<UnifiedAttentionItemV1['userMention']>): unknown | null {
  if (!Number.isSafeInteger(userMention.expectedRevision) || userMention.expectedRevision === undefined) return null;
  return {
    kind: 'user_mention',
    messageId: userMention.messageId,
    expectedRevision: userMention.expectedRevision,
  };
}

function legacyQuestionProjectionMatches(item: UnifiedAttentionItemV1): boolean {
  const choice = item.choiceRequest;
  const runtime = item.runtimeInteraction;
  if (!choice) return false;
  if (!runtime) return true;
  return Boolean(
    !item.approval &&
      runtime.kind === 'question' &&
      runtime.interactionId === choice.interactionId &&
      runtime.revision === choice.revision &&
      runtime.requesterCatId === choice.requesterCatId &&
      runtime.createdAt === choice.createdAt &&
      runtime.title === choice.title &&
      runtime.cardRef.threadId === choice.cardRef.threadId &&
      runtime.cardRef.messageId === choice.cardRef.messageId &&
      runtime.cardRef.blockId === choice.cardRef.blockId,
  );
}

function preferenceCoordinate(item: UnifiedAttentionItemV1): UnifiedAttentionPreferenceCoordinate | undefined {
  const versionPayload = exactVersionPayload(item);
  if (!versionPayload) return undefined;
  const version = `sha256:${createHash('sha256')
    .update(canonical({ decisionRef: item.decisionRef, version: versionPayload }))
    .digest('hex')}`;
  return { kind: 'mailbox', decisionRef: item.decisionRef, version };
}

export function attachDecisionPreferenceCoordinates(items: UnifiedAttentionItemV1[]): UnifiedAttentionItemV1[] {
  return items.map((item) => {
    const coordinate = preferenceCoordinate(item);
    return coordinate ? { ...item, preferenceCoordinate: coordinate } : item;
  });
}
