import type { ApprovalProducerId } from './types/approval-hub.js';
import {
  HUMAN_DISPOSITION_REASON_CODES,
  type HumanDispositionFeedbackInput,
  type HumanDispositionReasonCode,
  humanDispositionFeedbackInputSchema,
} from './types/human-disposition-feedback.js';

export interface ApprovalProducerCatalogEntry {
  /** Compact Chinese label used in filters and history. */
  label: string;
  /** Stable product label used on actionable cards. */
  badgeLabel: string;
  /** CSS token (with optional fallback) consumed by the Web surface. */
  colorToken: string;
  /** Feature-owned approve/reject endpoint base. */
  decisionEndpointBase: string;
  sourcePolicy: 'message-required' | 'message-or-event';
  history: boolean;
  /** Null keeps the producer on its existing binary reject path. */
  humanDispositionReasonCodes: readonly HumanDispositionReasonCode[] | null;
}

/**
 * Static producer truth shared by API and Web.
 *
 * A producer ID is added here only in the same change that supplies its API
 * runtime adapter binding. Wave 0 therefore contains the six existing Hub
 * producers; later Phase-I waves extend the type and catalog atomically.
 */
export const APPROVAL_PRODUCER_CATALOG = {
  F128: {
    label: '线程',
    badgeLabel: 'Thread',
    colorToken: 'var(--semantic-info)',
    decisionEndpointBase: '/api/proposals',
    sourcePolicy: 'message-required',
    history: true,
    humanDispositionReasonCodes: null,
  },
  F139: {
    label: '定时',
    badgeLabel: 'Schedule',
    colorToken: 'var(--semantic-warning, #f59e0b)',
    decisionEndpointBase: '/api/schedule-proposals',
    sourcePolicy: 'message-or-event',
    history: true,
    humanDispositionReasonCodes: null,
  },
  F193: {
    label: '派发',
    badgeLabel: 'Dispatch',
    colorToken: 'var(--semantic-success, #22c55e)',
    decisionEndpointBase: '/api/dispatch-proposals',
    sourcePolicy: 'message-or-event',
    history: true,
    humanDispositionReasonCodes: null,
  },
  F221: {
    label: '品味',
    badgeLabel: 'Taste',
    colorToken: 'var(--accent-taste, #e879f9)',
    decisionEndpointBase: '/api/taste-proposals',
    sourcePolicy: 'message-or-event',
    history: true,
    humanDispositionReasonCodes: null,
  },
  F225: {
    label: '会话',
    badgeLabel: 'Handoff',
    colorToken: 'var(--semantic-secondary, #8b5cf6)',
    decisionEndpointBase: '/api/session-handoff',
    sourcePolicy: 'message-required',
    history: true,
    humanDispositionReasonCodes: HUMAN_DISPOSITION_REASON_CODES,
  },
  F231: {
    label: '画像',
    badgeLabel: 'Profile',
    colorToken: 'var(--semantic-warning, #f59e0b)',
    decisionEndpointBase: '/api/profile-updates',
    sourcePolicy: 'message-required',
    history: true,
    humanDispositionReasonCodes: null,
  },
  F260: {
    label: '实体',
    badgeLabel: 'Entity',
    colorToken: 'var(--accent-entity, #06b6d4)',
    decisionEndpointBase: '/api/entity-proposals',
    sourcePolicy: 'message-or-event',
    history: true,
    humanDispositionReasonCodes: null,
  },
  F276: {
    label: '人物',
    badgeLabel: 'People',
    colorToken: 'var(--accent-people, #14b8a6)',
    decisionEndpointBase: '/api/person-memory-proposals',
    sourcePolicy: 'message-required',
    history: true,
    humanDispositionReasonCodes: ['not_important', 'wrong_lane', 'bad_evidence', 'wrong', 'other'],
  },
} as const satisfies Record<ApprovalProducerId, ApprovalProducerCatalogEntry>;

/** Stable display/fan-out order; preserves the existing Hub order during registry migration. */
export const APPROVAL_PRODUCER_IDS = Object.freeze([
  'F128',
  'F139',
  'F225',
  'F193',
  'F231',
  'F260',
  'F221',
  'F276',
] as const satisfies readonly ApprovalProducerId[]);

export function approvalProducerMeta(producerId: ApprovalProducerId): ApprovalProducerCatalogEntry {
  return APPROVAL_PRODUCER_CATALOG[producerId];
}

export type HumanDispositionFeedbackValidationResult =
  | { success: true; data: HumanDispositionFeedbackInput | undefined }
  | { success: false; reason: 'invalid_input' | 'feedback_not_enabled' | 'reason_not_allowed' };

export function validateHumanDispositionFeedbackForProducer(
  producerId: ApprovalProducerId,
  input: unknown,
): HumanDispositionFeedbackValidationResult {
  const parsed = humanDispositionFeedbackInputSchema.optional().safeParse(input);
  if (!parsed.success) return { success: false, reason: 'invalid_input' };
  if (!parsed.data) return { success: true, data: undefined };

  const reasonCodes = approvalProducerMeta(producerId).humanDispositionReasonCodes;
  if (!reasonCodes) return { success: false, reason: 'feedback_not_enabled' };
  if (!reasonCodes.includes(parsed.data.reasonCode)) return { success: false, reason: 'reason_not_allowed' };
  return { success: true, data: parsed.data };
}
