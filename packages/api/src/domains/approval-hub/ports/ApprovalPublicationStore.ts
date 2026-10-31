import type { ApprovalEnvelope, ApprovalPublication } from '@cat-cafe/shared';

/** Feature-store publication facet consumed by the shared ApprovalIngress. */
export interface ApprovalPublicationStore {
  getPublication(proposalId: string): ApprovalPublication | null | Promise<ApprovalPublication | null>;
  commitEnvelope(proposalId: string, envelope: ApprovalEnvelope): void | Promise<void>;
  abortStaged(proposalId: string, reason: string): void | Promise<void>;
}

export type ApprovalPublicationReader = Pick<ApprovalPublicationStore, 'getPublication'>;
