import type { CatRoutingError } from './cat-routing.js';
import type { MessageContent } from './message.js';

export type LifecycleQueuePriority = 'urgent' | 'normal';

/** RFC #1356: the only sender identity shared by Queue and History. */
export type MessageFrom =
  | { readonly kind: 'user'; readonly userId: string }
  | { readonly kind: 'agent'; readonly catId: string }
  | {
      readonly kind: 'external';
      readonly connectorId: string;
      readonly sender?: { readonly id: string; readonly name?: string };
      readonly address?: { readonly chatId: string; readonly messageId?: string };
    }
  | { readonly kind: 'plugin'; readonly instanceId: string }
  | { readonly kind: 'system'; readonly service: string };

/** @deprecated Use MessageFrom. */
export type LifecycleMessageFrom = MessageFrom;

export interface LifecycleInlinePayload {
  readonly type: 'inline';
  readonly body: readonly MessageContent[];
  readonly routingWarnings?: readonly CatRoutingError[];
}

export interface LifecycleMessageRefPayload {
  readonly type: 'message_ref';
  readonly messageId: string;
}

interface LifecycleQueueEntryBase {
  readonly id: string;
  readonly threadId: string;
  readonly from: MessageFrom;
  readonly targets: readonly string[];
  readonly ownerAuthProvenance: 'strict' | 'compatibility_fallback' | 'unknown';
  readonly priority: LifecycleQueuePriority;
  readonly enqueuedAt: number;
}

export type LifecycleQueueEntry =
  | (LifecycleQueueEntryBase & {
      readonly kind: 'conversation_input';
      readonly sourceRecordId: string;
      readonly payload: LifecycleInlinePayload;
      readonly position?: number;
    })
  | (LifecycleQueueEntryBase & {
      readonly kind: 'message_wake';
      readonly payload: LifecycleMessageRefPayload;
      readonly position?: number;
    })
  | (LifecycleQueueEntryBase & {
      readonly kind: 'private_input';
      readonly payload: LifecycleInlinePayload;
    });

export interface LifecycleQueueSnapshot {
  readonly revision: string;
  readonly entries: readonly LifecycleQueueEntry[];
  /** Exact visible rows that the server declared reorderable at this revision. */
  readonly reorderableVisibleEntryIds: readonly string[];
}

export interface ReorderVisibleLifecycleEntriesCommand {
  readonly threadId: string;
  readonly expectedQueueRevision: string;
  readonly orderedVisibleEntryIds: readonly string[];
}

export type LifecycleDispatchRef =
  | { readonly targetId: string; readonly phase: 'assigned' }
  | { readonly targetId: string; readonly phase: 'dispatched'; readonly statusMessageId: string }
  | { readonly targetId: string; readonly phase: 'settled'; readonly statusMessageId: string };

export interface LifecycleMessageMetadata {
  readonly orderKey: string;
  readonly dispatchRefs?: readonly LifecycleDispatchRef[];
  readonly producerInvocationId?: string;
}

export type LifecycleDeliveryFailureReason =
  | 'no_available_target'
  | 'invalid_explicit_target'
  | 'control_carrier_missing'
  | 'control_carrier_replaced';

/**
 * Durable lifecycle metadata stored beside the canonical message body.
 *
 * The body intentionally remains on StoredMessage.content/contentBlocks so it
 * cannot diverge from a second lifecycle-owned copy.
 */
export type LifecycleStoredMessageMetadata =
  | (LifecycleMessageMetadata & {
      readonly kind: 'input';
    })
  | (LifecycleMessageMetadata & {
      readonly kind: 'response';
      readonly invocationId: string;
      readonly targetId: string;
      readonly inputEntryIds: readonly string[];
      readonly inputMessageIds: readonly string[];
      readonly status: 'processing' | 'completed' | 'failed' | 'canceled' | 'interrupted';
      readonly startedAt: number;
      readonly completedAt?: number;
      readonly reason?: string;
    })
  | (LifecycleMessageMetadata & {
      readonly kind: 'delivery_failure';
      readonly status: 'failed';
      readonly sourceEntryId: string;
      readonly inputMessageId: string;
      readonly requestedTargets: readonly string[];
      readonly reason: LifecycleDeliveryFailureReason;
      readonly createdAt: number;
    });

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function isMessageFrom(value: unknown): value is MessageFrom {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  switch (candidate.kind) {
    case 'user':
      return isNonEmptyString(candidate.userId);
    case 'agent':
      return isNonEmptyString(candidate.catId);
    case 'external':
      return (
        isNonEmptyString(candidate.connectorId) &&
        (candidate.sender === undefined ||
          (candidate.sender !== null &&
            typeof candidate.sender === 'object' &&
            isNonEmptyString((candidate.sender as Record<string, unknown>).id) &&
            ((candidate.sender as Record<string, unknown>).name === undefined ||
              isNonEmptyString((candidate.sender as Record<string, unknown>).name)))) &&
        (candidate.address === undefined ||
          (candidate.address !== null &&
            typeof candidate.address === 'object' &&
            isNonEmptyString((candidate.address as Record<string, unknown>).chatId) &&
            ((candidate.address as Record<string, unknown>).messageId === undefined ||
              isNonEmptyString((candidate.address as Record<string, unknown>).messageId))))
      );
    case 'plugin':
      return isNonEmptyString(candidate.instanceId);
    case 'system':
      return isNonEmptyString(candidate.service);
    default:
      return false;
  }
}

function isDispatchRef(value: unknown): value is LifecycleDispatchRef {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  if (!isNonEmptyString(candidate.targetId)) return false;
  if (candidate.phase === 'assigned') return candidate.statusMessageId === undefined;
  return (
    (candidate.phase === 'dispatched' || candidate.phase === 'settled') && isNonEmptyString(candidate.statusMessageId)
  );
}

/** Fail-closed parser guard for the independent Redis lifecycle field. */
export function isLifecycleStoredMessageMetadata(value: unknown): value is LifecycleStoredMessageMetadata {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  if (
    !isNonEmptyString(candidate.orderKey) ||
    // Legacy lifecycle rows duplicated MessageFrom here. Accept only a valid
    // legacy copy so hydration can lift it to StoredMessage.from and strip it.
    (candidate.from !== undefined && !isMessageFrom(candidate.from)) ||
    (candidate.dispatchRefs !== undefined &&
      (!Array.isArray(candidate.dispatchRefs) || !candidate.dispatchRefs.every(isDispatchRef))) ||
    (candidate.producerInvocationId !== undefined && !isNonEmptyString(candidate.producerInvocationId))
  ) {
    return false;
  }
  if (candidate.kind === 'input') return true;
  if (candidate.kind === 'delivery_failure') {
    return (
      candidate.status === 'failed' &&
      isNonEmptyString(candidate.sourceEntryId) &&
      isNonEmptyString(candidate.inputMessageId) &&
      Array.isArray(candidate.requestedTargets) &&
      candidate.requestedTargets.every(isNonEmptyString) &&
      new Set(candidate.requestedTargets).size === candidate.requestedTargets.length &&
      [
        'no_available_target',
        'invalid_explicit_target',
        'control_carrier_missing',
        'control_carrier_replaced',
      ].includes(String(candidate.reason)) &&
      isFiniteTimestamp(candidate.createdAt)
    );
  }
  if (
    candidate.kind !== 'response' ||
    !isNonEmptyString(candidate.invocationId) ||
    !isNonEmptyString(candidate.targetId) ||
    !Array.isArray(candidate.inputEntryIds) ||
    !candidate.inputEntryIds.every(isNonEmptyString) ||
    !Array.isArray(candidate.inputMessageIds) ||
    !candidate.inputMessageIds.every(isNonEmptyString) ||
    !['processing', 'completed', 'failed', 'canceled', 'interrupted'].includes(String(candidate.status)) ||
    !isFiniteTimestamp(candidate.startedAt)
  ) {
    return false;
  }
  if (candidate.status === 'processing') {
    return candidate.completedAt === undefined && candidate.reason === undefined;
  }
  return (
    isFiniteTimestamp(candidate.completedAt) &&
    candidate.completedAt >= candidate.startedAt &&
    (candidate.reason === undefined || isNonEmptyString(candidate.reason))
  );
}

export interface LifecycleDeliveryFailureResult {
  readonly kind: 'delivery_failure';
  readonly status: 'failed';
  readonly id: string;
  readonly threadId: string;
  readonly orderKey: string;
  readonly sourceEntryId: string;
  readonly inputMessageId: string;
  readonly requestedTargets: readonly string[];
  readonly reason: LifecycleDeliveryFailureReason;
  readonly body: readonly MessageContent[];
  readonly createdAt: number;
}

export interface LifecycleResponseBubble {
  readonly id: string;
  readonly threadId: string;
  readonly orderKey: string;
  readonly invocationId: string;
  readonly targetId: string;
  readonly inputEntryIds: readonly string[];
  readonly inputMessageIds: readonly string[];
  readonly body: readonly MessageContent[];
  readonly status: 'processing' | 'completed' | 'failed' | 'canceled' | 'interrupted';
  readonly dispatchRefs?: readonly LifecycleDispatchRef[];
  readonly startedAt: number;
  readonly completedAt?: number;
  readonly reason?: string;
}

export interface LifecycleActiveRun {
  readonly threadId: string;
  readonly targetId: string;
  readonly invocationId: string;
  readonly responseMessageId: string;
  readonly inputEntryIds: readonly string[];
  readonly inputMessageIds: readonly string[];
  readonly privateInputEntryIds: readonly string[];
  readonly startedAt: number;
}

/** Exact live-run fence returned by the server for one explicit Queue Append. */
export interface LifecycleAppendExpectedRun {
  readonly targetId: string;
  readonly invocationId: string;
  readonly responseMessageId: string;
}

/**
 * Server-authored Append affordance. The client must echo both fences and may
 * never infer Append eligibility from a locally visible "working" badge.
 */
export interface LifecycleAppendAction {
  readonly kind: 'append';
  readonly expectedQueueRevision: string;
  readonly expectedRuns: readonly LifecycleAppendExpectedRun[];
}

export interface StructuredOwnerAdmissionBinding {
  readonly invocationId: string;
  readonly entryId: string;
  readonly targetId: string;
  readonly ownerKind: string;
  readonly ownerSubjectRef: string;
  readonly leaseId?: string;
  readonly generation: number;
  readonly frozenPredicate: {
    readonly kind: string;
    readonly value: string;
    readonly headSha?: string;
  };
  readonly principal: {
    readonly tenantId: string;
    readonly routeId: string;
    readonly callbackPrincipalId: string;
  };
  readonly admittedAt: number;
}
