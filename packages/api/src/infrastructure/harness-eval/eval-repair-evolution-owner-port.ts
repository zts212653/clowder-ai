import { type ExactAssetVersionRefV1, type OwnerTruthRefV1, ownerTruthRefV1Schema } from '@cat-cafe/shared';
import type { EvalRepairApprovalService } from './eval-repair-approval.js';
import {
  type EvalRepairAuthenticatedPrincipal,
  type EvalRepairOwnerLineage,
  type EvalRepairProposeResult,
  locateEvalRepairApproval,
} from './eval-repair-approval-contracts.js';
import {
  buildMetabolismDecisionEvent,
  type MetabolismDecisionEventInput,
  metabolismDecisionResult,
  projectEvalRepairEvolutionSnapshot,
  proposalIdFromRef,
  sameRef,
} from './eval-repair-evolution-owner-projection.js';
import { evalRepairCaseRef, evalRepairProposalRef } from './eval-repair-outcome-refs.js';
import type { IReevalClosureEventLog } from './reeval-closure-event-log.js';
import type { EvalLifecycleEvent } from './reeval-closure-schema.js';

export type { EvalRepairEvolutionSnapshot } from './eval-repair-evolution-owner-projection.js';

const CLOSED_EFFECTS = Object.freeze({
  approvalProposal: false,
  approvalCard: false,
  ownerContact: false,
  mutation: false,
  outcome: false,
  decisionEvent: false,
});

type RequestBlockReason =
  | 'request_origin_unverified'
  | 'lineage_missing'
  | 'lineage_ambiguous'
  | 'lineage_mismatch'
  | 'case_action_not_found'
  | 'approval_lifecycle_unavailable'
  | 'approval_materialization_in_progress'
  | 'approval_already_materialized'
  | 'owner_unresolved'
  | 'owner_ambiguous'
  | 'owner_authorization_missing'
  | 'owner_authorization_unreadable'
  | 'owner_authorization_expired'
  | 'owner_authorization_target_mismatch'
  | 'target_version_mismatch';

export type EvalRepairValueDecisionAuthority =
  | { kind: 'owner_session'; userId: string }
  | ({ kind: 'owner_source' } & EvalRepairAuthenticatedPrincipal);

export interface EvalRepairApprovalRequest {
  programRef: OwnerTruthRefV1;
  cycleRef: OwnerTruthRefV1;
  interventionRef: OwnerTruthRefV1;
  clientMessageId: string;
  requestAuthority: EvalRepairAuthenticatedPrincipal;
}

export type EvalRepairApprovalRequestResult =
  | {
      status: 'pending';
      caseRef: OwnerTruthRefV1;
      proposalRef: OwnerTruthRefV1;
      ownerAuthorizationRef: OwnerTruthRefV1;
      targetVersionRef: ExactAssetVersionRefV1;
    }
  | { status: 'blocked'; reason: string };

export interface EvalRepairApprovalRequestPort {
  requestApproval(input: EvalRepairApprovalRequest): Promise<EvalRepairApprovalRequestResult>;
}

export interface EvalRepairEvolutionOwnerPortOptions {
  contractVersion: number;
  eventLog?: IReevalClosureEventLog;
  approvalService?: Pick<EvalRepairApprovalService, 'propose'>;
  requestAuthorityVerifier?: {
    verify(
      authority: EvalRepairAuthenticatedPrincipal,
    ): Promise<
      { status: 'verified'; principal: EvalRepairAuthenticatedPrincipal } | { status: 'blocked'; reason: string }
    >;
  };
  lineageResolver?: {
    resolve(
      lineage: EvalRepairOwnerLineage,
    ): Promise<{ status: 'resolved'; caseActionRef: string } | { status: 'blocked'; reason: RequestBlockReason }>;
  };
  valueDecisionAuthorityVerifier?: {
    verify(
      authority: unknown,
      subject: {
        programRef: OwnerTruthRefV1;
        cycleRef: OwnerTruthRefV1;
        caseRef: OwnerTruthRefV1;
        proposalRef: OwnerTruthRefV1;
        outcomeReceiptRef: OwnerTruthRefV1;
      },
    ): Promise<{ status: 'verified'; authorityRef: OwnerTruthRefV1 } | { status: 'blocked'; reason: string }>;
  };
  decisionOwner?: {
    execute(input: {
      programRef: OwnerTruthRefV1;
      cycleRef: OwnerTruthRefV1;
      caseRef: OwnerTruthRefV1;
      proposalRef: OwnerTruthRefV1;
      outcomeReceiptRef: OwnerTruthRefV1;
      decision: 'keep' | 'tune' | 'rollback' | 'sunset' | 'no_change';
      clientMessageId: string;
      idempotencyRef: string;
      decisionAuthorityRef: OwnerTruthRefV1;
    }): Promise<
      | {
          status: 'recorded' | 'duplicate';
          decisionRef: OwnerTruthRefV1;
          executionReceiptRef?: OwnerTruthRefV1;
          assetVersionRef?: ExactAssetVersionRefV1;
        }
      | { status: 'blocked'; reason: string }
    >;
  };
  now?: () => string;
}

type CompleteOptions = EvalRepairEvolutionOwnerPortOptions &
  Required<
    Pick<
      EvalRepairEvolutionOwnerPortOptions,
      | 'eventLog'
      | 'approvalService'
      | 'requestAuthorityVerifier'
      | 'lineageResolver'
      | 'valueDecisionAuthorityVerifier'
      | 'decisionOwner'
    >
  >;

export function createEvalRepairEvolutionOwnerPort(
  options: EvalRepairEvolutionOwnerPortOptions,
):
  | { status: 'blocked'; missing: string[]; effects: typeof CLOSED_EFFECTS }
  | { status: 'active'; port: EvalRepairEvolutionOwnerPort } {
  const missing = missingBindings(options);
  if (missing.length > 0) return { status: 'blocked', missing, effects: CLOSED_EFFECTS };
  return { status: 'active', port: new EvalRepairEvolutionOwnerPort(options as CompleteOptions) };
}

function missingBindings(options: EvalRepairEvolutionOwnerPortOptions): string[] {
  const missing: string[] = [];
  if (options.contractVersion !== 1) missing.push('contractVersion@1');
  for (const key of [
    'eventLog',
    'approvalService',
    'requestAuthorityVerifier',
    'lineageResolver',
    'valueDecisionAuthorityVerifier',
    'decisionOwner',
  ] as const) {
    if (!options[key]) missing.push(key);
  }
  return missing;
}

function parseLineage(input: EvalRepairOwnerLineage): EvalRepairOwnerLineage | undefined {
  try {
    return {
      programRef: ownerTruthRefV1Schema.parse(input.programRef),
      cycleRef: ownerTruthRefV1Schema.parse(input.cycleRef),
      interventionRef: ownerTruthRefV1Schema.parse(input.interventionRef),
    };
  } catch {
    return undefined;
  }
}

function lineageMatches(
  input: { programRef: OwnerTruthRefV1; cycleRef: OwnerTruthRefV1 },
  lineage: EvalRepairOwnerLineage,
): boolean {
  return sameRef(input.programRef, lineage.programRef) && sameRef(input.cycleRef, lineage.cycleRef);
}

function nonPublishedRequestReason(result: Exclude<EvalRepairProposeResult, { status: 'published' }>): string {
  switch (result.status) {
    case 'blocked':
      return result.reason;
    case 'not_required':
      return 'approval_not_actionable';
    case 'superseded':
      return 'approval_superseded_before_publication';
    default: {
      const unhandled: never = result;
      return unhandled;
    }
  }
}

export class EvalRepairEvolutionOwnerPort implements EvalRepairApprovalRequestPort {
  private readonly now: () => string;

  constructor(private readonly options: CompleteOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async requestApproval(input: EvalRepairApprovalRequest): Promise<EvalRepairApprovalRequestResult> {
    const authority = await this.options.requestAuthorityVerifier.verify(input.requestAuthority);
    if (authority.status === 'blocked') return { status: 'blocked' as const, reason: authority.reason };
    const lineage = parseLineage(input);
    if (!lineage) return { status: 'blocked' as const, reason: 'lineage_missing' };
    const resolved = await this.options.lineageResolver.resolve(lineage);
    if (resolved.status === 'blocked') return resolved;
    const proposed = await this.options.approvalService.propose({
      caseActionRef: resolved.caseActionRef,
      clientMessageId: input.clientMessageId,
      principal: authority.principal,
      ownerLineage: lineage,
    });
    if (proposed.status !== 'published') {
      return { status: 'blocked', reason: nonPublishedRequestReason(proposed) };
    }
    const located = await locateEvalRepairApproval(this.options.eventLog, proposed.proposalId);
    if (!located) throw new Error('published F266 owner proposal disappeared');
    return {
      status: 'pending' as const,
      caseRef: evalRepairCaseRef(located.caseId, located.record.proposal.verdictId),
      proposalRef: evalRepairProposalRef(proposed.proposalId),
      ownerAuthorizationRef: located.record.proposal.requestSnapshot.ownerAuthorizationRef,
      targetVersionRef: located.record.proposal.requestSnapshot.targetVersionRef,
    };
  }

  async resolveChange(input: { caseRef: OwnerTruthRefV1; proposalRef: OwnerTruthRefV1 }) {
    const proposalId = proposalIdFromRef(input.proposalRef);
    if (!proposalId) return { status: 'blocked' as const, reason: 'proposal_mismatch' };
    const located = await locateEvalRepairApproval(this.options.eventLog, proposalId);
    if (!located) return { status: 'blocked' as const, reason: 'proposal_not_found' };
    if (!sameRef(input.caseRef, evalRepairCaseRef(located.caseId, located.record.proposal.verdictId))) {
      return { status: 'blocked' as const, reason: 'case_mismatch' };
    }
    const snapshot = projectEvalRepairEvolutionSnapshot(await this.options.eventLog.read(located.caseId), proposalId);
    if (
      (snapshot.status === 'rejected' ||
        snapshot.status === 'withdrawn' ||
        snapshot.status === 'superseded' ||
        snapshot.status === 'target_drift') &&
      !snapshot.decisionRef
    ) {
      return { status: 'blocked' as const, reason: 'decision_ref_missing' };
    }
    return snapshot;
  }

  async recordMetabolismDecision(input: {
    programRef: OwnerTruthRefV1;
    cycleRef: OwnerTruthRefV1;
    caseRef: OwnerTruthRefV1;
    proposalRef: OwnerTruthRefV1;
    outcomeReceiptRef: OwnerTruthRefV1;
    decision: 'keep' | 'tune' | 'rollback' | 'sunset' | 'no_change';
    clientMessageId: string;
    decisionAuthority: unknown;
  }) {
    const snapshot = await this.resolveChange({ caseRef: input.caseRef, proposalRef: input.proposalRef });
    if ('reason' in snapshot) return snapshot;
    const proposalId = proposalIdFromRef(input.proposalRef);
    if (!proposalId) return { status: 'blocked' as const, reason: 'proposal_mismatch' };
    const located = await locateEvalRepairApproval(this.options.eventLog, proposalId);
    if (!located?.record.proposal.ownerLineage) return { status: 'blocked' as const, reason: 'binding_missing' };
    const lineage = located.record.proposal.ownerLineage;
    if (!lineageMatches(input, lineage)) {
      return { status: 'blocked' as const, reason: 'lineage_mismatch' };
    }
    if (snapshot.status !== 'outcome' || !snapshot.outcomeReceiptRef) {
      return { status: 'blocked' as const, reason: 'outcome_missing' };
    }
    if (!sameRef(input.outcomeReceiptRef, snapshot.outcomeReceiptRef)) {
      return { status: 'blocked' as const, reason: 'outcome_mismatch' };
    }
    const verified = await this.options.valueDecisionAuthorityVerifier.verify(input.decisionAuthority, {
      programRef: lineage.programRef,
      cycleRef: lineage.cycleRef,
      caseRef: input.caseRef,
      proposalRef: input.proposalRef,
      outcomeReceiptRef: input.outcomeReceiptRef,
    });
    if (verified.status === 'blocked') return verified;
    const existing = findMetabolismDecision(await this.options.eventLog.read(located.caseId), proposalId);
    const replay = existingDecision(existing, input);
    if (replay) return replay;
    const eventId = `f266:${located.caseId}:metabolism:${proposalId}`;
    const idempotencyRef = `eval-repair-metabolism:${proposalId}:${input.outcomeReceiptRef.ownerFeatureId}:${input.outcomeReceiptRef.ownerStateRef}`;
    const result = await this.options.decisionOwner.execute({
      programRef: lineage.programRef,
      cycleRef: lineage.cycleRef,
      caseRef: input.caseRef,
      proposalRef: input.proposalRef,
      outcomeReceiptRef: input.outcomeReceiptRef,
      decision: input.decision,
      clientMessageId: input.clientMessageId,
      idempotencyRef,
      decisionAuthorityRef: verified.authorityRef,
    });
    if (result.status === 'blocked') return result;
    const event = buildMetabolismDecisionEvent(
      located.record.proposal,
      eventId,
      input,
      verified.authorityRef,
      result,
      this.now(),
    );
    return commitMetabolismDecision(this.options.eventLog, located.caseId, proposalId, event, input);
  }
}

function findMetabolismDecision(events: readonly EvalLifecycleEvent[], proposalId: string) {
  return events.find((event) => event.type === 'repair_metabolism_decided' && event.proposalId === proposalId);
}

function existingDecision(
  event: ReturnType<typeof findMetabolismDecision>,
  input: Pick<MetabolismDecisionEventInput, 'decision' | 'outcomeReceiptRef'>,
) {
  if (event?.type !== 'repair_metabolism_decided') return undefined;
  if (event.decision !== input.decision || !sameRef(event.outcomeReceiptRef, input.outcomeReceiptRef)) {
    return { status: 'blocked' as const, reason: 'idempotency_collision' };
  }
  return metabolismDecisionResult('duplicate', event);
}

async function commitMetabolismDecision(
  eventLog: IReevalClosureEventLog,
  caseId: string,
  proposalId: string,
  event: Extract<EvalLifecycleEvent, { type: 'repair_metabolism_decided' }>,
  input: Pick<MetabolismDecisionEventInput, 'decision' | 'outcomeReceiptRef'>,
) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await eventLog.read(caseId);
    const replay = existingDecision(findMetabolismDecision(current, proposalId), input);
    if (replay) return replay;
    const appended = await eventLog.append(event, current.length);
    if (appended.outcome === 'appended') return metabolismDecisionResult('recorded', event);
  }
  throw new Error(`F266 metabolism decision CAS did not converge for ${caseId}`);
}
