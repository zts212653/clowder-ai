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
  /**
   * Whether this producer may use the system-authored origin exemption in
   * `ApprovalIngress.validateOrigin`.
   *
   * `server_attested` asserts the producer derives `originRef.threadId`,
   * `originRef.messageId` and `ownerUserId` from an authenticated
   * InvocationRecord that a request body cannot rewrite. Only then is a system
   * pseudo-user row inside the already-bound owner thread safe to accept as an
   * origin, because the caller — not the request — fixed which thread and owner
   * may be named.
   *
   * `forbidden` is the default for every producer that has not demonstrated that
   * binding. The field is REQUIRED so that adding a producer without deciding
   * this is a compile error rather than a silent inherited exemption.
   *
   * WHAT THIS FIELD IS NOT (@codex-luna, PR #1349 P2): it is a policy DECLARATION,
   * not a runtime proof that the named adapter actually binds. `required` stops an
   * omission; it cannot stop a WRONG declaration. Proof has to come from route-level
   * / integration coverage or a typed adapter binding — so treat a `server_attested`
   * value as a claim that must have an audit trail next to it, which is why each
   * entry below records who walked which creation site.
   *
   * Current `forbidden` values are deliberate, each for its own reason:
   *   F139 — publication always constructs an EVENT origin, and validateOrigin
   *          returns early for `kind === 'event'`, so the exemption is inert here.
   *   F221 — genuinely unbound: `sourceMessageId` may be supplied by the request
   *          body and the derive path does NOT tie it back to the InvocationRecord.
   *          This is the honest negative case for the ingress test.
   *   F276 — candidate `sourceRef` can come from an owner-validated deferred receipt
   *          or owner evidence rather than one InvocationRecord; needs scheduler /
   *          deferred route coverage before it could be attested.
   *   F292 — MeetingIntake lands through signal admission and never calls
   *          ApprovalIngress.publish, so this value has no effect on this ingress.
   */
  systemOriginExemption: 'server_attested' | 'forbidden';
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
    // TRANSITIVE binding. callback-propose-thread-routes writes the proposal row
    // entirely off the authenticated record — sourceThreadId=record.threadId,
    // sourceMessageId=record.originTriggerMessageId ?? record.a2aTriggerMessageId,
    // createdBy=record.userId — and then builds originRef from that row. A request
    // body cannot rewrite any of the three. Verified at the creation site by opus5.
    systemOriginExemption: 'server_attested',
    history: true,
    humanDispositionReasonCodes: null,
  },
  F139: {
    label: '定时',
    badgeLabel: 'Schedule',
    colorToken: 'var(--semantic-warning, #f59e0b)',
    decisionEndpointBase: '/api/schedule-proposals',
    sourcePolicy: 'message-or-event',
    systemOriginExemption: 'forbidden',
    history: true,
    humanDispositionReasonCodes: null,
  },
  F193: {
    label: '派发',
    badgeLabel: 'Dispatch',
    colorToken: 'var(--semantic-success, #22c55e)',
    decisionEndpointBase: '/api/dispatch-proposals',
    sourcePolicy: 'message-or-event',
    // deriveCallbackOriginRef takes messageId off the authenticated record; threadId
    // is either the authenticated actor's (DIRECT) or the persisted proposal's
    // sourceThreadId (TRANSITIVE, same shape as F128). Creation-site audit by
    // @codex-luna, PR #1349 review — not independently re-walked by opus5.
    systemOriginExemption: 'server_attested',
    history: true,
    humanDispositionReasonCodes: null,
  },
  F221: {
    label: '品味',
    badgeLabel: 'Taste',
    colorToken: 'var(--accent-taste, #e879f9)',
    decisionEndpointBase: '/api/taste-proposals',
    sourcePolicy: 'message-or-event',
    systemOriginExemption: 'forbidden',
    history: true,
    humanDispositionReasonCodes: null,
  },
  F225: {
    label: '会话',
    badgeLabel: 'Handoff',
    colorToken: 'var(--semantic-secondary, #8b5cf6)',
    decisionEndpointBase: '/api/session-handoff',
    sourcePolicy: 'message-required',
    // callback-propose-session-handoff reads originTriggerMessageId /
    // a2aTriggerMessageId, threadId and userId off the authenticated
    // InvocationRecord; the request body cannot rewrite any of them.
    systemOriginExemption: 'server_attested',
    history: true,
    humanDispositionReasonCodes: HUMAN_DISPOSITION_REASON_CODES,
  },
  F231: {
    label: '画像',
    badgeLabel: 'Profile',
    colorToken: 'var(--semantic-warning, #f59e0b)',
    decisionEndpointBase: '/api/profile-updates',
    sourcePolicy: 'message-required',
    // DIRECT binding, and the strictest of the set: a body-supplied sourceMessageId
    // is rejected unless it equals the record-derived originMessageId
    // (callback-propose-profile-update-routes.ts: `sourceMessageId !== originMessageId`
    // → reject); omitting it falls back to the record value. Verified by opus5.
    systemOriginExemption: 'server_attested',
    history: true,
    humanDispositionReasonCodes: null,
  },
  F260: {
    label: '实体',
    badgeLabel: 'Entity',
    colorToken: 'var(--accent-entity, #06b6d4)',
    decisionEndpointBase: '/api/entity-proposals',
    sourcePolicy: 'message-or-event',
    // deriveEntityOriginRef is the same shape as F193: messageId off the
    // authenticated record, threadId from the actor or the persisted proposal row.
    // Creation-site audit by @codex-luna, PR #1349 review — not independently
    // re-walked by opus5.
    systemOriginExemption: 'server_attested',
    history: true,
    humanDispositionReasonCodes: null,
  },
  F276: {
    label: '人物',
    badgeLabel: 'People',
    colorToken: 'var(--accent-people, #14b8a6)',
    decisionEndpointBase: '/api/person-memory-proposals',
    sourcePolicy: 'message-required',
    systemOriginExemption: 'forbidden',
    history: true,
    humanDispositionReasonCodes: ['not_important', 'wrong_lane', 'bad_evidence', 'wrong', 'other'],
  },
  F292: {
    label: '会议',
    badgeLabel: 'Meeting',
    colorToken: 'var(--semantic-info, #3b82f6)',
    decisionEndpointBase: '/api/meeting-intakes',
    sourcePolicy: 'message-or-event',
    systemOriginExemption: 'forbidden',
    history: true,
    humanDispositionReasonCodes: null,
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
  'F292',
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
