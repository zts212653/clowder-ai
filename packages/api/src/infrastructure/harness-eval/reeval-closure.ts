import {
  type EvalLifecycleEvent,
  EvalLifecycleEventSchema,
  type EvalLifecycleRef,
  type EvalVerdictLifecycleStatus,
} from './reeval-closure-schema.js';

export interface ReevalClosureRoot {
  verdictId: string;
  domainId: string;
  targetOwnerCatId: string;
  assignedEvalCatId?: string;
  reevalWithinHours?: number;
}

export interface ReevalClosureEscalation {
  eventId: string;
  stage: 'acknowledgement' | 'reevaluation';
  dueAt: string;
}

export interface ReevalClosureProjection {
  verdictId: string;
  domainId: string;
  status: EvalVerdictLifecycleStatus;
  sequence: number;
  targetOwnerCatId: string;
  lifecycleOwnerCatId?: string;
  refs: readonly EvalLifecycleRef[];
  ownerResponseRefs: readonly EvalLifecycleRef[];
  planRefs: readonly EvalLifecycleRef[];
  actionRefs: readonly EvalLifecycleRef[];
  reevalRefs: readonly EvalLifecycleRef[];
  reevalDueAt?: string;
  reevalAssignedCatId?: string;
  closureReason?: string;
  escalation?: ReevalClosureEscalation;
  history: readonly EvalLifecycleEvent[];
}

export type ReevalClosureProjectionErrorCode =
  | 'invalid_root'
  | 'invalid_event'
  | 'invalid_history'
  | 'identity_mismatch'
  | 'illegal_transition'
  | 'authority_mismatch'
  | 'terminal_history';

export class ReevalClosureProjectionError extends Error {
  constructor(
    readonly code: ReevalClosureProjectionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ReevalClosureProjectionError';
  }
}

const TERMINAL_STATUSES: ReadonlySet<EvalVerdictLifecycleStatus> = new Set(['resolved', 'suppressed_with_reason']);

function requireRoot(root: ReevalClosureRoot): void {
  for (const [field, value] of Object.entries({
    verdictId: root.verdictId,
    domainId: root.domainId,
    targetOwnerCatId: root.targetOwnerCatId,
  })) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new ReevalClosureProjectionError('invalid_root', `lifecycle root ${field} must be non-empty`);
    }
  }
  if (root.assignedEvalCatId !== undefined && root.assignedEvalCatId.trim().length === 0) {
    throw new ReevalClosureProjectionError('invalid_root', 'lifecycle root assignedEvalCatId must be non-empty');
  }
}

function requireEventIdentity(root: ReevalClosureRoot, event: EvalLifecycleEvent, index: number): void {
  if (event.verdictId !== root.verdictId) {
    throw new ReevalClosureProjectionError(
      'identity_mismatch',
      `event ${index} verdictId ${event.verdictId} does not match ${root.verdictId}`,
    );
  }
  if (event.domainId !== root.domainId) {
    throw new ReevalClosureProjectionError(
      'identity_mismatch',
      `event ${index} domainId ${event.domainId} does not match ${root.domainId}`,
    );
  }
}

function requireActor(event: EvalLifecycleEvent, kind: EvalLifecycleEvent['actor']['kind'], id?: string): void {
  if (event.actor.kind !== kind || (id !== undefined && event.actor.id !== id)) {
    const expected = id === undefined ? kind : `${kind}:${id}`;
    throw new ReevalClosureProjectionError(
      'authority_mismatch',
      `${event.type} requires ${expected}; received ${event.actor.kind}:${event.actor.id}`,
    );
  }
}

function requireLifecycleOwner(event: EvalLifecycleEvent, lifecycleOwnerCatId: string | undefined): void {
  if (lifecycleOwnerCatId === undefined) {
    throw new ReevalClosureProjectionError(
      'authority_mismatch',
      `${event.type} requires an acknowledged active lifecycle owner`,
    );
  }
  if (event.actor.kind !== 'cat' || event.actor.id !== lifecycleOwnerCatId) {
    throw new ReevalClosureProjectionError(
      'authority_mismatch',
      `${event.type} actor must match active lifecycle owner ${lifecycleOwnerCatId}`,
    );
  }
}

function illegalTransition(status: EvalVerdictLifecycleStatus, event: EvalLifecycleEvent): never {
  throw new ReevalClosureProjectionError(
    'illegal_transition',
    `illegal transition: ${event.type} cannot follow ${status}`,
  );
}

export function projectReevalClosure(root: ReevalClosureRoot, rawEvents: readonly unknown[]): ReevalClosureProjection {
  requireRoot(root);
  if (rawEvents.length === 0) {
    throw new ReevalClosureProjectionError('invalid_history', 'first event must be verdict_opened');
  }

  const history = rawEvents.map((rawEvent, index) => {
    const parsed = EvalLifecycleEventSchema.safeParse(rawEvent);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
      throw new ReevalClosureProjectionError('invalid_event', `invalid lifecycle event ${index}: ${issues}`);
    }
    requireEventIdentity(root, parsed.data, index);
    return parsed.data;
  });

  if (history[0]?.type !== 'verdict_opened') {
    throw new ReevalClosureProjectionError('invalid_history', 'first event must be verdict_opened');
  }
  if (history[0].actor.kind !== 'automation' && history[0].actor.kind !== 'migration') {
    throw new ReevalClosureProjectionError(
      'authority_mismatch',
      'verdict_opened requires publisher automation or migration authority',
    );
  }

  let status: EvalVerdictLifecycleStatus = 'open';
  let targetOwnerCatId = root.targetOwnerCatId;
  let lifecycleOwnerCatId: string | undefined;
  let reevalDueAt: string | undefined;
  let reevalAssignedCatId: string | undefined;
  let closureReason: string | undefined;
  let escalation: ReevalClosureEscalation | undefined;
  const refs: EvalLifecycleRef[] = [...history[0].refs];
  const ownerResponseRefs: EvalLifecycleRef[] = [];
  const planRefs: EvalLifecycleRef[] = [];
  const actionRefs: EvalLifecycleRef[] = [];
  const reevalRefs: EvalLifecycleRef[] = [];

  for (const [index, event] of history.entries()) {
    if (index === 0) continue;
    if (event.type === 'verdict_opened') {
      throw new ReevalClosureProjectionError('invalid_history', 'verdict_opened may appear only once');
    }
    if (TERMINAL_STATUSES.has(status)) {
      throw new ReevalClosureProjectionError(
        'terminal_history',
        `${event.type} cannot follow terminal lifecycle status ${status}`,
      );
    }

    refs.push(...event.refs);

    if (event.type === 'owner_reassigned') {
      const currentOwner = lifecycleOwnerCatId ?? targetOwnerCatId;
      const actorCanReassign =
        event.actor.kind === 'cvo' || (event.actor.kind === 'cat' && event.actor.id === currentOwner);
      if (!actorCanReassign) {
        throw new ReevalClosureProjectionError(
          'authority_mismatch',
          `owner_reassigned requires operator or current owner ${currentOwner}`,
        );
      }
      targetOwnerCatId = event.targetOwnerCatId;
      if (lifecycleOwnerCatId !== undefined) lifecycleOwnerCatId = event.targetOwnerCatId;
      continue;
    }

    switch (event.type) {
      case 'owner_acknowledged':
        if (status !== 'open' && !(status === 'escalated' && escalation?.stage === 'acknowledgement')) {
          illegalTransition(status, event);
        }
        requireActor(event, 'cat', targetOwnerCatId);
        lifecycleOwnerCatId = targetOwnerCatId;
        ownerResponseRefs.push(...event.refs);
        status = 'acknowledged';
        break;
      case 'action_planned':
        if (status !== 'acknowledged' && status !== 'escalated') illegalTransition(status, event);
        requireLifecycleOwner(event, lifecycleOwnerCatId);
        planRefs.push(...event.refs);
        status = 'action_planned';
        break;
      case 'fix_recorded':
        if (status !== 'action_planned') illegalTransition(status, event);
        requireLifecycleOwner(event, lifecycleOwnerCatId);
        actionRefs.push(...event.refs);
        status = 'fix_landed';
        break;
      case 'reeval_requested': {
        if (status !== 'fix_landed') illegalTransition(status, event);
        if (
          event.assignedEvalCatId === undefined &&
          !event.refs.some((reference) => reference.availability === 'unavailable')
        ) {
          throw new ReevalClosureProjectionError(
            'authority_mismatch',
            `${event.type} without a pinned eval cat requires explicitly unavailable authority evidence`,
          );
        }
        const authorizedCatIds = new Set([lifecycleOwnerCatId, event.assignedEvalCatId].filter(Boolean));
        if (event.actor.kind !== 'cat' || !authorizedCatIds.has(event.actor.id)) {
          throw new ReevalClosureProjectionError(
            'authority_mismatch',
            `${event.type} requires the active lifecycle owner or this cycle's assigned eval cat`,
          );
        }
        reevalRefs.push(...event.refs);
        reevalDueAt = event.dueAt;
        reevalAssignedCatId = event.assignedEvalCatId;
        status = 'reeval_pending';
        break;
      }
      case 'reeval_passed':
      case 'reeval_failed': {
        if (status !== 'reeval_pending' && !(status === 'escalated' && escalation?.stage === 'reevaluation')) {
          illegalTransition(status, event);
        }
        if (reevalAssignedCatId !== undefined && event.assignedEvalCatId !== reevalAssignedCatId) {
          throw new ReevalClosureProjectionError(
            'authority_mismatch',
            `${event.type} assigned eval cat must match this cycle's pinned principal ${reevalAssignedCatId}`,
          );
        }
        const resultEvalCatId = reevalAssignedCatId ?? event.assignedEvalCatId;
        requireActor(event, 'cat', resultEvalCatId);
        reevalAssignedCatId = resultEvalCatId;
        reevalRefs.push(...event.refs);
        if (event.type === 'reeval_passed') {
          closureReason = event.reason;
          status = 'resolved';
        } else {
          status = 'action_planned';
        }
        break;
      }
      case 'cvo_suppressed':
        requireActor(event, 'cvo');
        closureReason = event.reason;
        status = 'suppressed_with_reason';
        break;
      case 'sla_escalated':
        requireActor(event, 'automation');
        if (
          (status === 'open' && event.stage !== 'acknowledgement') ||
          (status === 'reeval_pending' && event.stage !== 'reevaluation') ||
          (status !== 'open' && status !== 'reeval_pending')
        ) {
          illegalTransition(status, event);
        }
        escalation = { eventId: event.eventId, stage: event.stage, dueAt: event.dueAt };
        status = 'escalated';
        break;
    }
  }

  const hasActiveReevalDue =
    status === 'reeval_pending' || (status === 'escalated' && escalation?.stage === 'reevaluation');
  const activeEscalation = status === 'escalated' ? escalation : undefined;

  return {
    verdictId: root.verdictId,
    domainId: root.domainId,
    status,
    sequence: history.length,
    targetOwnerCatId,
    lifecycleOwnerCatId,
    refs,
    ownerResponseRefs,
    planRefs,
    actionRefs,
    reevalRefs,
    ...(hasActiveReevalDue && reevalDueAt ? { reevalDueAt } : {}),
    reevalAssignedCatId,
    closureReason,
    ...(activeEscalation ? { escalation: activeEscalation } : {}),
    history,
  };
}
