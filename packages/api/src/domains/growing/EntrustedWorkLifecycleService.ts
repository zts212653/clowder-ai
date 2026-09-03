import { createHash } from 'node:crypto';
import {
  type CreateTaskInput,
  type CustodyAdmissionRequestV1,
  type CustodyAdmissionResultV1,
  catIdSchema,
  custodyAdmissionRequestV1Schema,
  custodyAdmissionResultV1Schema,
  type EntrustedWorkTerminalActionV1,
  type EntrustedWorkUpdateActionV1,
  entrustedWorkClosureSpecV1Schema,
  entrustedWorkTerminalActionV1Schema,
  entrustedWorkUpdateActionV1Schema,
  entrustedWorkV1Schema,
  type F310CustodyGrantRegistryV1,
  PHASE_B_INITIAL_CUSTODY_GRANT_REGISTRY,
  registeredCustodyGrantV1Schema,
  type TaskItem,
} from '@cat-cafe/shared';
import { z } from 'zod';
import type { EntrustedWorkTerminalClosure, ITaskStore } from '../cats/services/stores/ports/TaskStoreContract.js';

const boundedRef = z.string().trim().min(1).max(1_000);

const taskContextSchema = z
  .object({
    threadId: boundedRef,
    title: z.string().trim().min(1).max(200),
    why: z.string().max(1_000),
    createdBy: z.union([catIdSchema(), z.literal('user'), z.literal('system')]),
    ownerCatId: catIdSchema().nullable().optional(),
    userId: boundedRef.optional(),
  })
  .strict();

export const entrustedWorkAdmissionCommandV1Schema = z
  .object({
    task: taskContextSchema,
    admission: custodyAdmissionRequestV1Schema,
    closure: entrustedWorkClosureSpecV1Schema.optional(),
    time: entrustedWorkV1Schema.shape.time.optional(),
    artifactRefs: z.array(boundedRef).max(64).optional(),
  })
  .strict();

export const closeEntrustedWorkCommandV1Schema = z
  .object({
    taskId: boundedRef,
    ...entrustedWorkTerminalActionV1Schema.shape,
  })
  .strict();

export type EntrustedWorkAdmissionCommandV1 = z.infer<typeof entrustedWorkAdmissionCommandV1Schema>;
export type CloseEntrustedWorkCommandV1 = { readonly taskId: string } & EntrustedWorkTerminalActionV1;

export type EntrustedWorkLifecycleErrorCode =
  | 'ENTRUSTED_WORK_AUTHORIZATION_MISSING'
  | 'ENTRUSTED_WORK_AUTHORIZATION_STALE'
  | 'ENTRUSTED_WORK_AUTHORIZATION_SCOPE_MISMATCH'
  | 'ENTRUSTED_WORK_SOURCE_NOT_FOUND'
  | 'ENTRUSTED_WORK_SOURCE_SCOPE_MISMATCH'
  | 'ENTRUSTED_WORK_SOURCE_CUSTODY_MISMATCH'
  | 'ENTRUSTED_WORK_NOT_FOUND'
  | 'ENTRUSTED_WORK_CONTRACT_MISSING'
  | 'ENTRUSTED_WORK_REVISION_CONFLICT'
  | 'ENTRUSTED_WORK_ALREADY_CLOSED'
  | 'ENTRUSTED_WORK_NO_OP';

export class EntrustedWorkLifecycleError extends Error {
  constructor(
    readonly code: EntrustedWorkLifecycleErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'EntrustedWorkLifecycleError';
  }
}

export interface EntrustedWorkLifecycleOptions {
  readonly now?: () => number;
  readonly custodyGrantRegistry?: F310CustodyGrantRegistryV1;
}

export class EntrustedWorkLifecycleService {
  private readonly now: () => number;
  private readonly custodyGrantRegistry: F310CustodyGrantRegistryV1;

  constructor(
    private readonly tasks: ITaskStore,
    options: EntrustedWorkLifecycleOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    const registry = options.custodyGrantRegistry ?? PHASE_B_INITIAL_CUSTODY_GRANT_REGISTRY;
    this.custodyGrantRegistry = Object.fromEntries(
      Object.entries(registry).map(([grantRef, grant]) => [grantRef, registeredCustodyGrantV1Schema.parse(grant)]),
    );
  }

  async admitOrResume(input: EntrustedWorkAdmissionCommandV1): Promise<CustodyAdmissionResultV1> {
    const command = entrustedWorkAdmissionCommandV1Schema.parse(input);
    if (!command.admission.intendedOutcome) {
      return {
        result: 'needs_clarification',
        clarificationReason: 'The intended outcome is required before Task can claim custody.',
      };
    }
    if (!command.closure) {
      return {
        result: 'needs_clarification',
        clarificationReason: 'A closure condition and expected signal are required before Task can claim custody.',
      };
    }
    if (command.admission.basis === 'authorized_source') {
      this.assertCurrentAuthorization(command.admission);
    }

    const digest = createHash('sha256').update(command.admission.idempotencyKey).digest('hex');
    const receiptRef = `task:receipt:entrusted:${digest}:1`;
    const sourceRefs = [...new Set(command.admission.sourceRefs)].sort();
    const entrustedWork = entrustedWorkV1Schema.parse({
      revision: 1,
      admission: {
        basis: command.admission.basis,
        sourceRefs,
        idempotencyKey: command.admission.idempotencyKey,
        receiptRef,
        admittedAt: this.now(),
        ...(command.admission.basis === 'authorized_source'
          ? { authorityRef: command.admission.authorityProvenance.grantRef }
          : {}),
      },
      intendedOutcome: command.admission.intendedOutcome,
      time: command.time ?? {},
      artifactRefs: [...new Set(command.artifactRefs ?? [])].sort(),
      closure: {
        ...command.closure,
        state: 'open',
        evidenceRefs: [],
      },
    });
    const result = await this.tasks.admitEntrustedWork({
      subjectKey: `entrusted:${digest}`,
      task: {
        ...command.task,
        createdBy: command.task.createdBy as CreateTaskInput['createdBy'],
        ownerCatId: command.task.ownerCatId as CreateTaskInput['ownerCatId'],
      },
      entrustedWork,
    });
    return custodyAdmissionResultV1Schema.parse({
      result: result.kind,
      subjectRef: `task:work:${result.task.id}`,
      ownerRef: `task:item:${result.task.id}`,
      revision: result.task.entrustedWork?.revision,
      receiptRef: result.task.entrustedWork?.admission.receiptRef,
    });
  }

  async close(input: CloseEntrustedWorkCommandV1): Promise<TaskItem> {
    const command = closeEntrustedWorkCommandV1Schema.parse(input);
    const result = await this.tasks.closeEntrustedWork(command.taskId, {
      expectedRevision: command.expectedRevision,
      closure: command.closure as EntrustedWorkTerminalClosure,
    });
    switch (result.kind) {
      case 'closed':
        return result.task;
      case 'not_found':
        throw new EntrustedWorkLifecycleError('ENTRUSTED_WORK_NOT_FOUND', 'Task not found');
      case 'not_entrusted':
        throw new EntrustedWorkLifecycleError(
          'ENTRUSTED_WORK_CONTRACT_MISSING',
          'Task does not own an entrusted-work contract',
        );
      case 'revision_conflict':
        throw new EntrustedWorkLifecycleError(
          'ENTRUSTED_WORK_REVISION_CONFLICT',
          'Entrusted-work revision is no longer current',
        );
      case 'already_closed':
        throw new EntrustedWorkLifecycleError('ENTRUSTED_WORK_ALREADY_CLOSED', 'Entrusted work is already closed');
    }
  }

  async update(input: EntrustedWorkUpdateActionV1): Promise<TaskItem> {
    const command = entrustedWorkUpdateActionV1Schema.parse(input);
    const hasTimePatch =
      command.time !== undefined &&
      (Object.hasOwn(command.time, 'businessDeadline') || Object.hasOwn(command.time, 'reviewBy'));
    if (command.artifactRefs === undefined && !hasTimePatch) {
      throw new EntrustedWorkLifecycleError('ENTRUSTED_WORK_NO_OP', 'Entrusted-work update has no mutation');
    }
    const result = await this.tasks.updateEntrustedWork(command.taskId, {
      expectedRevision: command.expectedRevision,
      ...(command.time !== undefined ? { time: command.time } : {}),
      ...(command.artifactRefs !== undefined ? { artifactRefs: command.artifactRefs } : {}),
    });
    switch (result.kind) {
      case 'updated':
        return result.task;
      case 'not_found':
        throw new EntrustedWorkLifecycleError('ENTRUSTED_WORK_NOT_FOUND', 'Task not found');
      case 'not_entrusted':
        throw new EntrustedWorkLifecycleError(
          'ENTRUSTED_WORK_CONTRACT_MISSING',
          'Task does not own an entrusted-work contract',
        );
      case 'revision_conflict':
        throw new EntrustedWorkLifecycleError(
          'ENTRUSTED_WORK_REVISION_CONFLICT',
          'Entrusted-work revision is no longer current',
        );
      case 'already_closed':
        throw new EntrustedWorkLifecycleError('ENTRUSTED_WORK_ALREADY_CLOSED', 'Entrusted work is already closed');
      case 'no_change':
        throw new EntrustedWorkLifecycleError('ENTRUSTED_WORK_NO_OP', 'Entrusted-work update changes no owner truth');
    }
  }

  private assertCurrentAuthorization(
    admission: Extract<CustodyAdmissionRequestV1, { basis: 'authorized_source' }>,
  ): void {
    const provenance = admission.authorityProvenance;
    const grant = this.custodyGrantRegistry[provenance.grantRef];
    if (!grant) {
      throw new EntrustedWorkLifecycleError(
        'ENTRUSTED_WORK_AUTHORIZATION_MISSING',
        'No current custody grant is registered for this source',
      );
    }
    const expiry = grant.validity.state === 'current' ? grant.validity.expiresAt : null;
    const current =
      grant.validity.state === 'current' &&
      (expiry === null || (Number.isFinite(Date.parse(expiry)) && Date.parse(expiry) > this.now()));
    const coordinatesMatch =
      grant.grantRef === provenance.grantRef &&
      grant.revision === provenance.grantRevision &&
      grant.producerRef === provenance.producerRef &&
      grant.grantOwnerRef === provenance.grantOwnerRef &&
      grant.grantOwnerRevision === provenance.grantOwnerRevision &&
      grant.admissionAuthority === provenance.admissionAuthority &&
      grant.idempotencySource === provenance.idempotencySource;
    if (!current || !coordinatesMatch) {
      throw new EntrustedWorkLifecycleError(
        'ENTRUSTED_WORK_AUTHORIZATION_STALE',
        'Custody grant coordinates are stale, expired, or revoked',
      );
    }
    if (
      !admission.sourceRefs.includes(provenance.sourceRef) ||
      !grant.allowedSourceScope.includes(provenance.matchedScope)
    ) {
      throw new EntrustedWorkLifecycleError(
        'ENTRUSTED_WORK_AUTHORIZATION_SCOPE_MISMATCH',
        'Custody grant does not cover this source scope',
      );
    }
  }
}
