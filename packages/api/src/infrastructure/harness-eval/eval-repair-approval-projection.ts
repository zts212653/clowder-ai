import type {
  ApprovalEnvelope,
  ApprovalLifecycleProjection,
  ApprovalPublication,
  ExactAssetVersionRefV1,
  OwnerTruthRefV1,
} from '@cat-cafe/shared';
import { approvalLifecycleProjectionSchema } from '@cat-cafe/shared';
import type { ApprovalPublicationStore } from '../../domains/approval-hub/ports/ApprovalPublicationStore.js';
import type { IReevalClosureEventLog } from './reeval-closure-event-log.js';
import type { EvalLifecycleEvent } from './reeval-closure-schema.js';

export interface EvalRepairApprovalSnapshot {
  ownerRef: OwnerTruthRefV1;
  ownerAuthorizationRef: OwnerTruthRefV1;
  targetVersionRef: ExactAssetVersionRefV1;
  dispatchRef: OwnerTruthRefV1;
}

type ProposedEvent = Extract<EvalLifecycleEvent, { type: 'approval_proposed' }>;
type DecidedEvent = Extract<EvalLifecycleEvent, { type: 'approval_decided' }>;
type ApprovalRecordEvent = Extract<
  EvalLifecycleEvent,
  {
    type:
      | 'approval_anchored'
      | 'approval_publication_tombstoned'
      | 'approval_decided'
      | 'approval_superseded'
      | 'approval_materialization_started'
      | 'approval_materialized';
  }
>;

export interface EvalRepairApprovalRecord {
  proposal: ProposedEvent;
  lifecycle: ApprovalLifecycleProjection;
  publication: ApprovalPublication;
  decision?: DecidedEvent;
  approvalRef?: OwnerTruthRefV1;
  decidedAt?: string;
  supersededByCaseActionRef?: string;
  supersessionDrift?: 'owner' | 'authorization' | 'target';
  materializationAttempt?: Extract<EvalLifecycleEvent, { type: 'approval_materialization_started' }>;
  materialization?: Extract<EvalLifecycleEvent, { type: 'approval_materialized' }>;
}

export interface EvalRepairApprovalCaseProjection {
  proposals: readonly EvalRepairApprovalRecord[];
  active?: EvalRepairApprovalRecord;
}

export function projectEvalRepairApprovals(events: readonly EvalLifecycleEvent[]): EvalRepairApprovalCaseProjection {
  const records = new Map<string, EvalRepairApprovalRecord>();
  for (const event of events) {
    if (event.type === 'approval_proposed') {
      startApprovalRecord(records, event);
      continue;
    }
    if (!isApprovalRecordEvent(event)) continue;
    const record = records.get(event.proposalId);
    if (!record) throw new Error(`${event.type} references unknown proposal ${event.proposalId}`);
    applyApprovalRecordEvent(record, event);
  }
  const proposals = [...records.values()];
  for (const record of proposals) approvalLifecycleProjectionSchema.parse(record.lifecycle);
  const active = [...proposals]
    .reverse()
    .find((record) => record.lifecycle.resolution === 'open' || record.lifecycle.resolution === 'accepted');
  return { proposals, ...(active ? { active } : {}) };
}

function startApprovalRecord(records: Map<string, EvalRepairApprovalRecord>, event: ProposedEvent): void {
  if (records.has(event.proposalId)) throw new Error(`approval proposal ${event.proposalId} was created twice`);
  records.set(event.proposalId, {
    proposal: event,
    lifecycle: { resolution: 'open', materialization: { state: 'not_started' } },
    publication: { state: 'staged', stagedAt: Date.parse(event.occurredAt) },
  });
}

function isApprovalRecordEvent(event: EvalLifecycleEvent): event is ApprovalRecordEvent {
  return (
    event.type === 'approval_anchored' ||
    event.type === 'approval_publication_tombstoned' ||
    event.type === 'approval_decided' ||
    event.type === 'approval_superseded' ||
    event.type === 'approval_materialization_started' ||
    event.type === 'approval_materialized'
  );
}

function applyApprovalRecordEvent(record: EvalRepairApprovalRecord, event: ApprovalRecordEvent): void {
  switch (event.type) {
    case 'approval_anchored':
      anchorApproval(record, event);
      break;
    case 'approval_publication_tombstoned':
      tombstoneApproval(record, event);
      break;
    case 'approval_decided':
      decideApproval(record, event);
      break;
    case 'approval_superseded':
      supersedeApproval(record, event);
      break;
    case 'approval_materialization_started':
      startMaterialization(record, event);
      break;
    case 'approval_materialized':
      materializeApproval(record, event);
      break;
  }
}

function anchorApproval(
  record: EvalRepairApprovalRecord,
  event: Extract<ApprovalRecordEvent, { type: 'approval_anchored' }>,
): void {
  if (record.publication.state !== 'staged') throw new Error('approval envelope can only anchor a staged proposal');
  record.publication = { state: 'anchored', envelope: envelopeFrom(record.proposal, event) };
}

function tombstoneApproval(
  record: EvalRepairApprovalRecord,
  event: Extract<ApprovalRecordEvent, { type: 'approval_publication_tombstoned' }>,
): void {
  if (record.publication.state === 'anchored') throw new Error('anchored approval publication cannot be tombstoned');
  record.publication = { state: 'tombstoned', failedAt: Date.parse(event.failedAt), reason: event.reason };
  record.lifecycle = { resolution: 'closed_without_decision', materialization: { state: 'not_started' } };
}

function decideApproval(
  record: EvalRepairApprovalRecord,
  event: Extract<ApprovalRecordEvent, { type: 'approval_decided' }>,
): void {
  if (record.lifecycle.resolution !== 'open') throw new Error('Approval decision is one-shot');
  record.lifecycle = {
    resolution: event.resolution,
    materialization: event.resolution === 'accepted' ? { state: 'outcome_unknown' } : { state: 'not_started' },
  };
  record.decision = event;
  record.approvalRef = event.approvalRef;
  record.decidedAt = event.occurredAt;
}

function supersedeApproval(
  record: EvalRepairApprovalRecord,
  event: Extract<ApprovalRecordEvent, { type: 'approval_superseded' }>,
): void {
  if (record.lifecycle.resolution !== 'open' && record.lifecycle.resolution !== 'accepted') {
    throw new Error('only an open or accepted Approval can be superseded');
  }
  if (record.materialization) throw new Error('materialized Approval cannot be superseded');
  if (record.materializationAttempt && !event.dispatchRejectionRef) {
    throw new Error('started materialization requires canonical owner rejection proof before supersession');
  }
  record.lifecycle = { resolution: 'closed_without_decision', materialization: { state: 'not_started' } };
  record.supersededByCaseActionRef = event.freshCaseActionRef;
  record.supersessionDrift = event.drift;
}

function startMaterialization(
  record: EvalRepairApprovalRecord,
  event: Extract<ApprovalRecordEvent, { type: 'approval_materialization_started' }>,
): void {
  if (record.lifecycle.resolution !== 'accepted') throw new Error('materialization start requires accepted Approval');
  if (record.materializationAttempt) throw new Error('Approval materialization attempt is immutable');
  if (record.materialization) throw new Error('materialized Approval cannot start again');
  record.materializationAttempt = event;
  record.lifecycle = {
    resolution: 'accepted',
    materialization: { state: 'in_progress', attemptRef: event.dispatchId },
  };
}

function materializeApproval(
  record: EvalRepairApprovalRecord,
  event: Extract<ApprovalRecordEvent, { type: 'approval_materialized' }>,
): void {
  if (record.lifecycle.resolution !== 'accepted') throw new Error('materialization requires accepted Approval');
  if (record.materialization) throw new Error('Approval materialization receipt is immutable');
  if (!record.materializationAttempt || record.materializationAttempt.dispatchId !== event.dispatchId) {
    throw new Error('materialization receipt must match its durable dispatch attempt');
  }
  record.materialization = event;
  record.lifecycle = {
    resolution: 'accepted',
    materialization: { state: 'succeeded', effectProofRef: event.custodyReceiptRef.ownerStateRef },
  };
}

function envelopeFrom(
  proposed: ProposedEvent,
  anchored: Extract<EvalLifecycleEvent, { type: 'approval_anchored' }>,
): ApprovalEnvelope {
  return {
    canonicalProposalId: proposed.proposalId,
    sourceFeatureId: 'F266',
    ownerUserId: proposed.requestOrigin.ownerUserId,
    requesterCatId: proposed.requestOrigin.requesterCatId,
    originRef: {
      kind: 'message',
      threadId: proposed.requestOrigin.threadId,
      messageId: proposed.requestOrigin.messageId,
    },
    approvalCardRef: anchored.approvalCardRef,
    createdAt: Date.parse(proposed.occurredAt),
  };
}

export class EvalRepairApprovalPublicationStore implements ApprovalPublicationStore {
  constructor(private readonly eventLog: IReevalClosureEventLog) {}

  async getPublication(proposalId: string): Promise<ApprovalPublication | null> {
    const located = await this.locate(proposalId);
    if (!located) return null;
    return located.record.publication;
  }

  async commitEnvelope(proposalId: string, envelope: ApprovalEnvelope): Promise<void> {
    const located = await this.locate(proposalId);
    if (!located) throw new Error(`approval proposal not found: ${proposalId}`);
    if (located.record.publication.state === 'anchored') {
      if (JSON.stringify(located.record.publication.envelope) !== JSON.stringify(envelope)) {
        throw new Error('conflicting approval envelope');
      }
      return;
    }
    if (located.record.publication.state !== 'staged') throw new Error('approval publication is not staged');
    const proposal = located.record.proposal;
    if (
      envelope.canonicalProposalId !== proposalId ||
      envelope.sourceFeatureId !== 'F266' ||
      envelope.ownerUserId !== proposal.requestOrigin.ownerUserId ||
      envelope.requesterCatId !== proposal.requestOrigin.requesterCatId ||
      envelope.originRef.kind !== 'message' ||
      envelope.originRef.threadId !== proposal.requestOrigin.threadId ||
      envelope.originRef.messageId !== proposal.requestOrigin.messageId
    ) {
      throw new Error('approval envelope identity does not match F266 proposal snapshot');
    }
    await this.appendAtCurrent(proposal.caseId, {
      eventId: `f266:${proposal.caseId}:proposal:${proposalId}:anchored`,
      caseId: proposal.caseId,
      verdictId: proposal.verdictId,
      domainId: proposal.domainId,
      type: 'approval_anchored',
      actor: { kind: 'automation', id: 'approval-ingress' },
      occurredAt: new Date(envelope.createdAt).toISOString(),
      reason: 'canonical Approval envelope anchored to its visible card',
      refs: [{ kind: 'message', availability: 'available', value: `message:${envelope.approvalCardRef.messageId}` }],
      proposalId,
      approvalEnvelopeRef: `approval-envelope:F266:${proposalId}`,
      approvalCardRef: envelope.approvalCardRef,
    });
  }

  async abortStaged(proposalId: string, reason: string): Promise<void> {
    const located = await this.locate(proposalId);
    if (!located || located.record.publication.state === 'tombstoned') return;
    if (located.record.publication.state !== 'staged') throw new Error('anchored approval publication cannot abort');
    const proposal = located.record.proposal;
    const occurredAt = new Date().toISOString();
    await this.appendAtCurrent(proposal.caseId, {
      eventId: `f266:${proposal.caseId}:proposal:${proposalId}:publication-tombstone`,
      caseId: proposal.caseId,
      verdictId: proposal.verdictId,
      domainId: proposal.domainId,
      type: 'approval_publication_tombstoned',
      actor: { kind: 'automation', id: 'approval-ingress' },
      occurredAt,
      failedAt: occurredAt,
      reason,
      refs: [{ kind: 'other', availability: 'available', value: `approval-proposal:${proposalId}` }],
      proposalId,
    });
  }

  private async locate(proposalId: string): Promise<{ caseId: string; record: EvalRepairApprovalRecord } | undefined> {
    for (const subjectId of await this.eventLog.listSubjectIds()) {
      const projection = projectEvalRepairApprovals(await this.eventLog.read(subjectId));
      const record = projection.proposals.find((candidate) => candidate.proposal.proposalId === proposalId);
      if (record) return { caseId: subjectId, record };
    }
    return undefined;
  }

  private async appendAtCurrent(caseId: string, event: EvalLifecycleEvent): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const events = await this.eventLog.read(caseId);
      const result = await this.eventLog.append(event, events.length);
      if (result.outcome !== 'conflict') return;
    }
    throw new Error(`F266 approval event CAS did not converge for ${caseId}`);
  }
}
