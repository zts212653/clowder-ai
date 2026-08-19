import type { ApprovalPublication } from './approval-hub.js';

export type ScheduleMutationTrigger =
  | { type: 'interval'; ms: number }
  | { type: 'cron'; expression: string; timezone?: string }
  | { type: 'once'; fireAt: number };

export type ScheduleMutationDisplayCategory = 'pr' | 'repo' | 'thread' | 'system' | 'external' | 'issue';

export interface ScheduleMutationTaskDefinition {
  id: string;
  templateId: string;
  trigger: ScheduleMutationTrigger;
  params: Record<string, unknown>;
  display: {
    label: string;
    category: ScheduleMutationDisplayCategory;
    description?: string;
    subjectKind?: 'pr' | 'repo' | 'thread' | 'external' | 'none' | 'issue';
  };
  deliveryThreadId: string | null;
  enabled: boolean;
  createdBy: string;
  createdAt: string;
}

export type ScheduleMutation =
  | { kind: 'create'; task: ScheduleMutationTaskDefinition; relativeOnceDelayMs?: number }
  | {
      kind: 'delete';
      taskId: string;
      expectedFingerprint: string;
      taskSnapshot: ScheduleMutationTaskDefinition;
    };

export type ScheduleMutationProposalStatus = 'pending' | 'applying' | 'approved' | 'rejected';

export type ScheduleMutationEffectCheckpoint =
  | { kind: 'create'; taskId: string; appliedAt: number }
  | { kind: 'delete'; taskId: string; expectedFingerprint: string; deletedAt: number };

export interface ScheduleMutationProposal {
  proposalId: string;
  ownerUserId: string;
  requesterCatId: string;
  mutation: ScheduleMutation;
  status: ScheduleMutationProposalStatus;
  publication: ApprovalPublication;
  effectCheckpoint?: ScheduleMutationEffectCheckpoint;
  createdAt: number;
  claimedAt?: number;
  approvedAt?: number;
  approvedBy?: string;
  rejectedAt?: number;
  rejectedBy?: string;
  rejectionReason?: string;
}

export type ScheduleMutationAuditAction = 'create' | 'pause' | 'resume' | 'delete';

export interface ScheduleMutationAuditEntry {
  auditId: string;
  ownerUserId: string;
  actorKind: 'cvo' | 'cat';
  actorId: string;
  action: ScheduleMutationAuditAction;
  taskId: string;
  detail: Record<string, unknown>;
  createdAt: number;
}
