import { createHash } from 'node:crypto';
import type {
  RuntimeConversationDecisionRequest,
  RuntimeInteractionCardRef,
  RuntimeInteractionRecord,
  RuntimeInteractionSubmission,
} from '@cat-cafe/shared';
import { type RuntimeConversationResponse, renderRuntimeConversationResponse } from '@cat-cafe/shared';
import { RuntimeInteractionError } from './RuntimeInteractionError.js';

export type RuntimeConversationInteractionRecord = RuntimeInteractionRecord & {
  readonly request: RuntimeConversationDecisionRequest;
  readonly source: Extract<RuntimeInteractionRecord['source'], { kind: 'conversation_decision' }>;
  readonly returnBinding: Extract<RuntimeInteractionRecord['returnBinding'], { kind: 'conversation_turn' }>;
};

export interface RuntimeConversationRequester {
  readonly userId: string;
  readonly threadId: string;
  readonly catId: string;
}

export interface RuntimeConversationOwnerMessageAuth {
  readonly ownerAuthProvenance: string;
  readonly originTriggerMessageId?: string;
}

export function sameConversationOperation(
  record: RuntimeInteractionRecord,
  operationId: string,
  digest: string,
): RuntimeInteractionRecord | null {
  if (record.terminal?.operationId === operationId) {
    if (record.terminal.responseDigest !== digest) {
      throw new RuntimeInteractionError('stale', 'operation id was already used with different content');
    }
    return record;
  }
  if (record.submission?.operationId === operationId && record.submission.responseDigest !== digest) {
    throw new RuntimeInteractionError('stale', 'operation id was already used with different content');
  }
  return null;
}

export function conversationDeliveryContent(
  request: RuntimeConversationDecisionRequest,
  submission: RuntimeInteractionSubmission,
): string {
  if (submission.terminal.reasonCode === 'expired') return '截止已到，没有收到选择。';
  if (!submission.response) throw new RuntimeInteractionError('stale', 'conversation return payload is unavailable');
  const rendered = renderRuntimeConversationResponse(request, submission.response as RuntimeConversationResponse);
  return submission.terminal.reasonCode === 'defaulted' ? `截止已到，按默认继续：${rendered}` : rendered;
}

export function conversationResponseDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function sameRuntimeInteractionCard(
  left: RuntimeInteractionCardRef | undefined,
  right: RuntimeInteractionCardRef,
): boolean {
  return Boolean(
    left &&
      left.threadId === right.threadId &&
      left.messageId === right.messageId &&
      left.blockId === right.blockId &&
      (!left.blockDigest || left.blockDigest === right.blockDigest) &&
      (!left.publishedAt || left.publishedAt === right.publishedAt),
  );
}

export function runtimeInteractionErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
