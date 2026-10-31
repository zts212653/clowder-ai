import type { CatId } from './ids.js';

export type WorkAdmissionProducerKind = 'workflow_sop_v1';

/** Canonical identity minted when an eligible managed workflow is first admitted. */
export interface WorkAdmission {
  readonly workId: string;
  readonly ownerUserId: string;
  readonly producerKind: WorkAdmissionProducerKind;
  readonly producerRef: string;
  readonly initialAttemptId: string;
  readonly admittedAt: number;
}

/** Phase B only creates attempt #1; later attempt allocation remains deferred. */
export interface WorkAttempt {
  readonly attemptId: string;
  readonly workId: string;
  readonly attemptNumber: 1;
  readonly executorCatId: CatId | null;
  readonly createdAt: number;
  readonly executorBoundAt: number | null;
}

export interface WorkflowSopAdmissionBundle {
  readonly admission: WorkAdmission;
  readonly attempt: WorkAttempt;
}

/** Internal identity carried by an authenticated invocation after executor bind. */
export interface ManagedWorkBinding {
  readonly workId: string;
  readonly attemptId: string;
}
