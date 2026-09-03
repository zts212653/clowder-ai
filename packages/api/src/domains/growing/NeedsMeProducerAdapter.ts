import type {
  ApprovalItem,
  ApprovalProducerId,
  EntrustedWorkTaskRefV1,
  MeetingIntake,
  PhaseBNeedsMeProducerId,
  ProducerAttentionReceiptV1,
  RuntimeInteractionRecord,
  SettledApprovalItem,
} from '@cat-cafe/shared';
import {
  APPROVAL_PRODUCER_IDS,
  approvalProducerMeta,
  meetingIntakeNeedsAttention,
  producerAttentionReceiptV1Schema,
} from '@cat-cafe/shared';
import type { ApprovalProducerRegistry } from '../approval-hub/ApprovalProducerRegistry.js';
import type { RuntimeInteractionStore } from '../runtime-interaction/ports/RuntimeInteractionStore.js';
import type { MeetingIntakeStore } from '../signal-intake/MeetingIntakeStore.js';

export interface NeedsMeProducerReadInput {
  readonly ownerUserId: string;
  readonly producerSubjectRef: string;
}

export interface NeedsMeProducerReevaluateInput extends NeedsMeProducerReadInput {
  readonly expectedProducerRevision: number;
  readonly taskRef: EntrustedWorkTaskRefV1;
  readonly reEvaluateActionRef: string;
}

export type NeedsMeProducerReevaluationResult =
  | { readonly state: 'unchanged' | 'refreshed'; readonly producerRevision: number }
  | { readonly state: 'retired'; readonly producerRevision: number | null }
  | { readonly state: 'stale'; readonly producerRevision: number | null };

/** Read-only producer boundary. Eligibility and salience arrive from the producer adapter, never owner-read. */
export interface NeedsMeProducerAdapter {
  readonly producerId: PhaseBNeedsMeProducerId;
  listCurrentReceipts(ownerUserId: string): Promise<ProducerAttentionReceiptV1[]>;
  readCurrentReceipt(input: NeedsMeProducerReadInput): Promise<ProducerAttentionReceiptV1 | null>;
  /** Canonical producer action. Implementations may mutate only their own record and must CAS their revision. */
  reEvaluate(input: NeedsMeProducerReevaluateInput): Promise<NeedsMeProducerReevaluationResult>;
}

async function reEvaluateCurrentReceipt(
  adapter: NeedsMeProducerAdapter,
  input: NeedsMeProducerReevaluateInput,
): Promise<NeedsMeProducerReevaluationResult> {
  const current = await adapter.readCurrentReceipt(input);
  if (!current) return { state: 'retired', producerRevision: null };
  const exact =
    current.producer.producerId === adapter.producerId &&
    current.producer.subjectRef === input.producerSubjectRef &&
    current.producer.revision === input.expectedProducerRevision &&
    current.taskRef.subjectRef === input.taskRef.subjectRef &&
    current.taskRef.observedRevision === input.taskRef.observedRevision &&
    current.reEvaluateActionRef === input.reEvaluateActionRef;
  if (!exact) return { state: 'stale', producerRevision: current.producer.revision };
  if (!current.eligible) return { state: 'retired', producerRevision: current.producer.revision };
  return { state: 'unchanged', producerRevision: current.producer.revision };
}

function producerCoordinate(
  producerId: PhaseBNeedsMeProducerId,
  subjectRef: string,
  revision: number,
): ProducerAttentionReceiptV1['producer'] {
  return { producerId, ownerRef: subjectRef, subjectRef, revision };
}

function parseTemporalRevision(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} is not a positive canonical revision`);
  return value;
}

function reEvaluateRef(subjectRef: string): string {
  return `${subjectRef}#reevaluate`;
}

interface F246Subject {
  readonly featureId: ApprovalProducerId;
  readonly proposalId: string;
}

function parseF246Subject(value: string): F246Subject | null {
  const match = /^approval:(F\d+):(.+)$/u.exec(value);
  if (!match?.[1] || !match[2]) return null;
  if (match[1] === 'F292' || match[1] === 'F306') return null;
  if (!APPROVAL_PRODUCER_IDS.includes(match[1] as ApprovalProducerId)) return null;
  return { featureId: match[1] as ApprovalProducerId, proposalId: match[2] };
}

function pendingApprovalActionRef(item: ApprovalItem): string {
  if (item.navigation.state === 'anchored' && !item.inlineApprovable) {
    const { threadId, messageId } = item.navigation.approvalCardRef;
    return `message:${threadId}:${messageId}`;
  }
  const base = approvalProducerMeta(item.sourceFeatureId).decisionEndpointBase;
  if (!base) {
    if (item.navigation.state !== 'anchored') throw new Error('origin-card approval is not anchored');
    const { threadId, messageId } = item.navigation.approvalCardRef;
    return `message:${threadId}:${messageId}`;
  }
  return `${base}/${encodeURIComponent(item.proposalId)}`;
}

function projectPendingApproval(item: ApprovalItem, producerSubjectRef: string): ProducerAttentionReceiptV1 | null {
  if (!item.entrustedWorkTaskRef) return null;
  const revision = parseTemporalRevision(item.createdAt, 'approval createdAt');
  return producerAttentionReceiptV1Schema.parse({
    eligible: item.status === 'pending' && item.navigation.state === 'anchored',
    producer: producerCoordinate('f246.approval', producerSubjectRef, revision),
    taskRef: item.entrustedWorkTaskRef,
    ...(item.status === 'pending' && item.navigation.state === 'anchored'
      ? {
          kind: 'judgment',
          reasonCode: `approval_pending:${item.sourceFeatureId}`,
          recommendation: item.summary,
          salience: 'normal',
          action: { actionRef: pendingApprovalActionRef(item), expectedProducerRevision: revision },
        }
      : {}),
    reEvaluateActionRef: reEvaluateRef(producerSubjectRef),
  });
}

function projectSettledApproval(
  item: SettledApprovalItem,
  producerSubjectRef: string,
): ProducerAttentionReceiptV1 | null {
  if (!item.entrustedWorkTaskRef) return null;
  return producerAttentionReceiptV1Schema.parse({
    eligible: false,
    producer: producerCoordinate(
      'f246.approval',
      producerSubjectRef,
      parseTemporalRevision(item.decidedAt, 'approval decidedAt'),
    ),
    taskRef: item.entrustedWorkTaskRef,
    reEvaluateActionRef: reEvaluateRef(producerSubjectRef),
  });
}

/** F246 is a read-through adapter over registered canonical approval owners, not another proposal store. */
export class F246NeedsMeProducerAdapter implements NeedsMeProducerAdapter {
  readonly producerId = 'f246.approval' as const;

  constructor(private readonly registry: Pick<ApprovalProducerRegistry, 'get' | 'listAdapters'>) {}

  async listCurrentReceipts(ownerUserId: string): Promise<ProducerAttentionReceiptV1[]> {
    const lists = await Promise.all(this.registry.listAdapters().map((adapter) => adapter.listPending(ownerUserId)));
    return lists.flatMap((items) =>
      items.flatMap((item) => {
        const subjectRef = `approval:${item.sourceFeatureId}:${item.proposalId}`;
        if (!parseF246Subject(subjectRef)) return [];
        const receipt = projectPendingApproval(item, subjectRef);
        return receipt?.eligible ? [receipt] : [];
      }),
    );
  }

  async readCurrentReceipt(input: NeedsMeProducerReadInput): Promise<ProducerAttentionReceiptV1 | null> {
    const subject = parseF246Subject(input.producerSubjectRef);
    if (!subject) return null;
    const adapter = this.registry.get(subject.featureId).adapter;
    const pending = (await adapter.listPending(input.ownerUserId)).find(
      (item) => item.proposalId === subject.proposalId && item.ownerUserId === input.ownerUserId,
    );
    if (pending) return projectPendingApproval(pending, input.producerSubjectRef);
    if (!adapter.listSettled) return null;
    const settled = (await adapter.listSettled(input.ownerUserId, { limit: 200 })).find(
      (item) => item.proposalId === subject.proposalId && item.ownerUserId === input.ownerUserId,
    );
    return settled ? projectSettledApproval(settled, input.producerSubjectRef) : null;
  }

  reEvaluate(input: NeedsMeProducerReevaluateInput): Promise<NeedsMeProducerReevaluationResult> {
    return reEvaluateCurrentReceipt(this, input);
  }
}

function meetingAction(intake: MeetingIntake): { reasonCode: string; recommendation: string; actionRef: string } {
  if (intake.healthState === 'degraded' && intake.repair) {
    return {
      reasonCode: intake.repair.code,
      recommendation: `Resolve the meeting source through ${intake.repair.action}`,
      actionRef: `/api/meeting-intakes/${encodeURIComponent(intake.intakeId)}/${intake.repair.action}`,
    };
  }
  return {
    reasonCode: `meeting_unresolved:${intake.unresolved[0] ?? 'choices'}`,
    recommendation: 'Confirm the unresolved meeting choices in the source intake',
    actionRef: `/api/meeting-intakes/${encodeURIComponent(intake.intakeId)}/confirm`,
  };
}

export class F292NeedsMeProducerAdapter implements NeedsMeProducerAdapter {
  readonly producerId = 'f292.repair' as const;

  constructor(private readonly store: Pick<MeetingIntakeStore, 'get' | 'list'>) {}

  async listCurrentReceipts(ownerUserId: string): Promise<ProducerAttentionReceiptV1[]> {
    const intakes = await this.store.list();
    return intakes.flatMap((intake) => {
      if (intake.ownerId !== ownerUserId || !intake.entrustedWorkTaskRef || !meetingIntakeNeedsAttention(intake)) {
        return [];
      }
      const receipt = this.project(intake);
      return receipt?.eligible ? [receipt] : [];
    });
  }

  async readCurrentReceipt(input: NeedsMeProducerReadInput): Promise<ProducerAttentionReceiptV1 | null> {
    const intake = await this.store.get(input.producerSubjectRef);
    if (!intake || intake.ownerId !== input.ownerUserId || !intake.entrustedWorkTaskRef) return null;
    return this.project(intake);
  }

  reEvaluate(input: NeedsMeProducerReevaluateInput): Promise<NeedsMeProducerReevaluationResult> {
    return reEvaluateCurrentReceipt(this, input);
  }

  private project(intake: MeetingIntake): ProducerAttentionReceiptV1 {
    const taskRef = intake.entrustedWorkTaskRef;
    if (!taskRef) throw new Error('linked meeting intake is missing entrusted Task coordinates');
    const producer = producerCoordinate(this.producerId, intake.intakeId, intake.revision);
    if (!meetingIntakeNeedsAttention(intake)) {
      return producerAttentionReceiptV1Schema.parse({
        eligible: false,
        producer,
        taskRef,
        reEvaluateActionRef: reEvaluateRef(intake.intakeId),
      });
    }
    const action = meetingAction(intake);
    return producerAttentionReceiptV1Schema.parse({
      eligible: true,
      producer,
      taskRef,
      kind: intake.healthState === 'degraded' ? 'repair' : 'judgment',
      reasonCode: action.reasonCode,
      recommendation: action.recommendation,
      salience: 'normal',
      action: { actionRef: action.actionRef, expectedProducerRevision: intake.revision },
      reEvaluateActionRef: reEvaluateRef(intake.intakeId),
    });
  }
}

function interactionActionRef(record: RuntimeInteractionRecord): string {
  const card = record.cardRef;
  if (!card) throw new Error('pending runtime interaction is not anchored');
  return `message:${card.threadId}:${card.messageId}#${card.blockId}`;
}

export class F306NeedsMeProducerAdapter implements NeedsMeProducerAdapter {
  readonly producerId = 'f306.runtime_interaction' as const;

  constructor(private readonly store: Pick<RuntimeInteractionStore, 'get' | 'listPendingByUser'>) {}

  async listCurrentReceipts(ownerUserId: string): Promise<ProducerAttentionReceiptV1[]> {
    const records = await this.store.listPendingByUser(ownerUserId);
    return records.flatMap((record) => {
      if (!record.request.entrustedWorkTaskRef) return [];
      const receipt = this.project(record);
      return receipt?.eligible ? [receipt] : [];
    });
  }

  async readCurrentReceipt(input: NeedsMeProducerReadInput): Promise<ProducerAttentionReceiptV1 | null> {
    const record = await this.store.get(input.producerSubjectRef);
    if (!record || record.request.owner.userId !== input.ownerUserId || !record.request.entrustedWorkTaskRef) {
      return null;
    }
    return this.project(record);
  }

  reEvaluate(input: NeedsMeProducerReevaluateInput): Promise<NeedsMeProducerReevaluationResult> {
    return reEvaluateCurrentReceipt(this, input);
  }

  private project(record: RuntimeInteractionRecord): ProducerAttentionReceiptV1 {
    const taskRef = record.request.entrustedWorkTaskRef;
    if (!taskRef) throw new Error('linked runtime interaction is missing entrusted Task coordinates');
    const revision = parseTemporalRevision(record.updatedAt, 'runtime interaction updatedAt');
    const subjectRef = record.request.interactionId;
    const producer = producerCoordinate(this.producerId, subjectRef, revision);
    if (record.status !== 'pending' || !record.cardRef) {
      return producerAttentionReceiptV1Schema.parse({
        eligible: false,
        producer,
        taskRef,
        reEvaluateActionRef: reEvaluateRef(subjectRef),
      });
    }
    return producerAttentionReceiptV1Schema.parse({
      eligible: true,
      producer,
      taskRef,
      kind: 'judgment',
      reasonCode: `runtime_interaction:${record.request.kind}`,
      recommendation: record.request.title,
      salience: 'normal',
      action: { actionRef: interactionActionRef(record), expectedProducerRevision: revision },
      reEvaluateActionRef: reEvaluateRef(subjectRef),
    });
  }
}
