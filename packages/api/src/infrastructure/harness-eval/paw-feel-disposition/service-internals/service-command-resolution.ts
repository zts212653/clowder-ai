import type {
  OwnerTruthRefV1,
  PawFeelDirectRepairOutcomeV1,
  PawFeelDispositionEvent,
  PawFeelDispositionProjection,
  PawFeelResumeSelectorV1,
} from '@cat-cafe/shared';
import { ownerTruthRefV1Schema } from '@cat-cafe/shared';
import {
  matchesPawFeelResumeSelectorRequest,
  type PawFeelResumeConditionResolver,
  preparePawFeelResumeCondition,
} from '../blocker-recovery/resume-condition.js';
import { resolvePawFeelCommandContext } from '../command-context.js';
import type { PawFeelDispositionCommand, PawFeelResolvedCommandContext } from '../commands.js';
import { PawFeelDirectRepairError } from '../direct-repair/direct-repair-errors.js';
import type { PawFeelDirectRepairResolution } from '../direct-repair/direct-repair-resolver.js';
import { PawFeelDispositionServiceError, type PawFeelTrustedPrincipal } from '../service-guards.js';
import { resolvePawFeelReplayContext } from './service-command-replay.js';

export interface PawFeelCommandEvidenceOptions {
  directRepairResolver?: {
    resolve(input: {
      projection: PawFeelDispositionProjection;
      leaseId: string;
      actionRef: string;
    }): Promise<PawFeelDirectRepairResolution>;
  };
  repairOutcomeResolver?: {
    resolve(input: {
      projection: PawFeelDispositionProjection;
      actor: Extract<PawFeelDispositionEvent['actor'], { kind: 'cat' | 'cvo' }>;
      bindingRef: OwnerTruthRefV1;
      ownerOutcomeRef: OwnerTruthRefV1;
    }): Promise<PawFeelDirectRepairOutcomeV1>;
  };
  resumeConditionResolver?: PawFeelResumeConditionResolver;
}

function serviceError(error: unknown, fallback: string): PawFeelDispositionServiceError {
  return error instanceof PawFeelDirectRepairError
    ? new PawFeelDispositionServiceError(error.code, error.message)
    : new PawFeelDispositionServiceError(
        'fix_evidence_invalid',
        `${fallback}: ${error instanceof Error ? error.message : String(error)}`,
      );
}

interface WriteContextInput {
  actor: PawFeelTrustedPrincipal;
  command: PawFeelDispositionCommand;
  projection: PawFeelDispositionProjection;
  existing?: PawFeelDispositionEvent;
  occurredAt: string;
  ownerCatId?: string;
  evidence: PawFeelCommandEvidenceOptions;
}

type Continuation = Extract<PawFeelDirectRepairResolution, { status: 'continuation' }>['continuation'];

async function resolveDirectFix(
  input: WriteContextInput,
  context: PawFeelResolvedCommandContext,
): Promise<Continuation | undefined> {
  const { command } = input;
  if (command.type !== 'mark_fix' && !(command.type === 'request_signature' && command.action.type === 'fix')) {
    return undefined;
  }
  const resolver = input.evidence.directRepairResolver;
  if (!resolver) {
    throw new PawFeelDispositionServiceError(
      'fix_evidence_invalid',
      'fix requires source-routed direct action authority in addition to Task/F167 custody',
    );
  }
  const requested =
    command.type === 'mark_fix'
      ? { leaseId: command.leaseId, actionRef: command.actionRef }
      : command.action.type === 'fix'
        ? command.action
        : undefined;
  if (!requested) throw new Error('unreachable non-fix signature action');
  let resolution: PawFeelDirectRepairResolution;
  try {
    resolution = await resolver.resolve({
      projection: input.projection,
      leaseId: requested.leaseId,
      actionRef: requested.actionRef,
    });
  } catch (error) {
    throw serviceError(error, 'direct repair authority is invalid');
  }
  if (resolution.status === 'continuation') return resolution.continuation;
  context.fix = resolution.fix;
  context.directRepairBinding = resolution.binding;
  if (command.type === 'request_signature') {
    context.signatureAction = { type: 'fix', ...resolution.fix, directRepairBinding: resolution.binding };
  }
  return undefined;
}

async function resolveRepairOutcome(input: WriteContextInput, context: PawFeelResolvedCommandContext): Promise<void> {
  if (input.command.type !== 'link_repair_outcome') return;
  const resolver = input.evidence.repairOutcomeResolver;
  if (!resolver) {
    throw new PawFeelDispositionServiceError(
      'fix_evidence_invalid',
      'repair outcome requires the direct owner verifier',
    );
  }
  try {
    context.repairOutcome = await resolver.resolve({
      projection: input.projection,
      actor: input.actor,
      bindingRef: input.command.bindingRef,
      ownerOutcomeRef: input.command.ownerOutcomeRef,
    });
  } catch (error) {
    throw serviceError(error, 'repair outcome evidence is invalid');
  }
}

async function resolveBlocker(input: WriteContextInput, context: PawFeelResolvedCommandContext): Promise<void> {
  if (input.command.type !== 'mark_blocked') return;
  const selector: PawFeelResumeSelectorV1 =
    input.command.resume.kind === 'bounded_time'
      ? {
          ...input.command.resume,
          dependencyRef: ownerTruthRefV1Schema.parse({
            ownerFeatureId: 'F310',
            ownerStateRef: `task:item:${requireRepairTaskId(input.projection)}`,
          }),
        }
      : input.command.resume;
  const replay = input.existing?.type === 'blocked' ? input.existing.resumeCondition : undefined;
  if (replay) {
    if (!matchesPawFeelResumeSelectorRequest(replay.selector, selector)) {
      throw new PawFeelDispositionServiceError(
        'idempotency_collision',
        `idempotency collision: blocker selector changed for ${input.command.eventId}`,
      );
    }
    context.resumeCondition = replay;
    return;
  }
  const resolver = input.evidence.resumeConditionResolver;
  if (!resolver) {
    throw new PawFeelDispositionServiceError(
      'resume_condition_invalid',
      'new blocker requires a canonical resume-condition resolver',
    );
  }
  try {
    context.resumeCondition = await preparePawFeelResumeCondition({
      signalId: input.command.signalId,
      blockingSequence: input.command.expectedSequence + 1,
      selector,
      resolver,
      now: input.occurredAt,
    });
  } catch (error) {
    throw new PawFeelDispositionServiceError(
      'resume_condition_invalid',
      `resume condition is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function requireRepairTaskId(projection: PawFeelDispositionProjection): string {
  if ((projection.state !== 'fix' && projection.state !== 'blocked') || !projection.taskId) {
    throw new PawFeelDispositionServiceError(
      'resume_condition_invalid',
      'bounded-time blocker requires an active repair task; use an exact task or owner-event condition',
    );
  }
  return projection.taskId;
}

export async function resolvePawFeelWriteContext(
  input: WriteContextInput,
): Promise<{ context: PawFeelResolvedCommandContext } | { continuation: Continuation }> {
  const replay = resolvePawFeelReplayContext(input.command, input.existing);
  if (replay) return { context: replay };
  if (input.projection.repairOutcome) {
    throw new PawFeelDispositionServiceError('invalid_command', 'verified repair outcome is terminal and immutable');
  }
  if (
    input.projection.state === 'closed' ||
    input.projection.state === 'duplicate' ||
    input.projection.state === 'no_action'
  ) {
    throw new PawFeelDispositionServiceError('invalid_command', 'terminal paw-feel disposition is immutable');
  }
  const context = await resolvePawFeelCommandContext(input.actor, input.command, input.ownerCatId);
  const continuation = await resolveDirectFix(input, context);
  if (continuation) return { continuation };
  await resolveRepairOutcome(input, context);
  await resolveBlocker(input, context);
  return { context };
}
