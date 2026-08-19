import { z } from 'zod';
import type { EvalReleaseTruthResolver, VerifiedEvalReleaseFact } from './eval-release-truth-resolver.js';
import { projectReevalCase, type ReevalCaseProjection, type ReevalCaseRoot } from './reeval-case.js';
import type { IReevalClosureEventLog, ReevalClosureAppendResult } from './reeval-closure-event-log.js';
import {
  type EvalLifecycleActor,
  EvalLifecycleActorSchema,
  type EvalLifecycleEvent,
  EvalLifecycleRefSchema,
} from './reeval-closure-schema.js';

const nonEmptyString = z.string().trim().min(1);
const commandBaseSchema = z
  .object({
    eventId: nonEmptyString,
    verdictId: nonEmptyString,
    expectedSequence: z.number().int().nonnegative(),
    reason: nonEmptyString,
    refs: z.array(EvalLifecycleRefSchema).min(1),
  })
  .strict();
const plainCommand = <T extends string>(type: T) => commandBaseSchema.extend({ type: z.literal(type) }).strict();
const releaseCommand = <T extends string>(type: T) =>
  commandBaseSchema
    .extend({ type: z.literal(type), commitSha: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/) })
    .strict();

export const ReevalCaseCommandSchema = z.discriminatedUnion('type', [
  plainCommand('plan_action'),
  releaseCommand('record_main_landed'),
  releaseCommand('record_live_active'),
  plainCommand('request_reeval'),
  commandBaseSchema.extend({ type: z.literal('record_reeval_result'), result: z.enum(['passed', 'failed']) }).strict(),
  plainCommand('suppress'),
]);

export type ReevalCaseCommand = z.infer<typeof ReevalCaseCommandSchema>;
export type ReevalCaseCommandResult =
  | { outcome: 'appended' | 'duplicate'; projection: ReevalCaseProjection }
  | Extract<ReevalClosureAppendResult, { outcome: 'conflict' }>;

export class ReevalCaseCommandError extends Error {
  constructor(
    readonly code:
      | 'invalid_command'
      | 'invalid_principal'
      | 'root_not_found'
      | 'case_not_initialized'
      | 'eval_authority_unavailable'
      | 'reeval_sla_unavailable'
      | 'idempotency_collision',
    message: string,
  ) {
    super(message);
    this.name = 'ReevalCaseCommandError';
  }
}

export interface ReevalCaseServiceOptions {
  eventLog: IReevalClosureEventLog;
  loadRoot: (verdictId: string) => Promise<ReevalCaseRoot | null | undefined>;
  releaseTruth: Pick<EvalReleaseTruthResolver, 'verifyMainLanded' | 'verifyLiveActive'>;
  now?: () => string;
}

function parsePrincipal(raw: unknown): EvalLifecycleActor {
  const parsed = EvalLifecycleActorSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ReevalCaseCommandError('invalid_principal', `invalid case lifecycle principal: ${parsed.error.message}`);
  }
  return parsed.data;
}

function parseCommand(raw: unknown): ReevalCaseCommand {
  const parsed = ReevalCaseCommandSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ReevalCaseCommandError('invalid_command', `invalid case lifecycle command: ${parsed.error.message}`);
  }
  return parsed.data;
}

function deriveReevalDueAt(root: ReevalCaseRoot, occurredAt: string): string {
  if (
    typeof root.reevalWithinHours !== 'number' ||
    !Number.isInteger(root.reevalWithinHours) ||
    root.reevalWithinHours <= 0
  ) {
    throw new ReevalCaseCommandError(
      'reeval_sla_unavailable',
      `cannot request re-evaluation for ${root.caseId} without a positive domain re-evaluation SLA`,
    );
  }
  return new Date(Date.parse(occurredAt) + root.reevalWithinHours * 3_600_000).toISOString();
}

function releaseRef(fact: VerifiedEvalReleaseFact) {
  return { kind: 'commit' as const, availability: 'available' as const, value: fact.evidenceRef };
}

function persistedReleaseFact(existing: EvalLifecycleEvent | undefined): VerifiedEvalReleaseFact | undefined {
  if (existing?.type !== 'main_landed' && existing?.type !== 'live_active') return undefined;
  const evidence = existing.refs.find(
    (ref) =>
      ref.availability === 'available' && ref.kind === 'commit' && /^(?:git:origin\/main@|runtime:)/.test(ref.value),
  );
  return evidence?.availability === 'available'
    ? { commitSha: existing.commitSha, evidenceRef: evidence.value }
    : undefined;
}

function commandToEvent(
  root: ReevalCaseRoot,
  projection: ReevalCaseProjection,
  actor: EvalLifecycleActor,
  command: ReevalCaseCommand,
  occurredAt: string,
  releaseTruth: ReevalCaseServiceOptions['releaseTruth'],
  existing?: EvalLifecycleEvent,
): EvalLifecycleEvent {
  const base = {
    eventId: command.eventId,
    caseId: root.caseId,
    verdictId: command.verdictId,
    domainId: root.domainId,
    actor,
    occurredAt,
    reason: command.reason,
    refs: command.refs,
  };
  switch (command.type) {
    case 'plan_action':
      return { ...base, type: 'action_planned' };
    case 'record_main_landed': {
      const fact = persistedReleaseFact(existing) ?? releaseTruth.verifyMainLanded(command.commitSha);
      if (fact.commitSha !== command.commitSha) {
        throw new ReevalCaseCommandError(
          'idempotency_collision',
          'main_landed retry changed canonical commit identity',
        );
      }
      return { ...base, type: 'main_landed', commitSha: fact.commitSha, refs: [...command.refs, releaseRef(fact)] };
    }
    case 'record_live_active': {
      const fact = persistedReleaseFact(existing) ?? releaseTruth.verifyLiveActive(command.commitSha);
      if (fact.commitSha !== command.commitSha) {
        throw new ReevalCaseCommandError(
          'idempotency_collision',
          'live_active retry changed canonical commit identity',
        );
      }
      return { ...base, type: 'live_active', commitSha: fact.commitSha, refs: [...command.refs, releaseRef(fact)] };
    }
    case 'request_reeval': {
      const persisted = existing?.type === 'reeval_requested' ? existing : undefined;
      const assignedEvalCatId = persisted?.assignedEvalCatId ?? root.assignedEvalCatId;
      if (!assignedEvalCatId) {
        throw new ReevalCaseCommandError(
          'eval_authority_unavailable',
          `cannot request re-evaluation for ${root.caseId} without a trusted eval cat`,
        );
      }
      return {
        ...base,
        type: 'reeval_requested',
        dueAt: persisted?.dueAt ?? deriveReevalDueAt(root, occurredAt),
        assignedEvalCatId,
      };
    }
    case 'record_reeval_result': {
      const eventType = command.result === 'passed' ? 'reeval_passed' : 'reeval_failed';
      const persistedAssignment = existing?.type === eventType ? existing.assignedEvalCatId : undefined;
      const assignedEvalCatId = persistedAssignment ?? projection.reevalAssignedCatId ?? root.assignedEvalCatId;
      if (!assignedEvalCatId) {
        throw new ReevalCaseCommandError(
          'eval_authority_unavailable',
          `cannot record re-evaluation result for ${root.caseId} without a trusted eval cat`,
        );
      }
      return { ...base, type: eventType, assignedEvalCatId };
    }
    case 'suppress':
      return { ...base, type: 'cvo_suppressed' };
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}

function fingerprint(event: EvalLifecycleEvent): string {
  const { occurredAt: _occurredAt, ...intent } = event;
  return JSON.stringify(canonicalize(intent));
}

function requireMatchingDuplicate(existing: EvalLifecycleEvent, attempted: EvalLifecycleEvent): void {
  if (fingerprint(existing) !== fingerprint(attempted)) {
    throw new ReevalCaseCommandError(
      'idempotency_collision',
      `eventId ${attempted.eventId} already belongs to a different case lifecycle event`,
    );
  }
}

export class ReevalCaseService {
  private readonly now: () => string;

  constructor(private readonly options: ReevalCaseServiceOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async execute(rawPrincipal: unknown, rawCommand: unknown): Promise<ReevalCaseCommandResult> {
    const principal = parsePrincipal(rawPrincipal);
    const command = parseCommand(rawCommand);
    const root = await this.options.loadRoot(command.verdictId);
    if (!root) throw new ReevalCaseCommandError('root_not_found', `no case lifecycle root for ${command.verdictId}`);
    const currentEvents = await this.options.eventLog.read(root.caseId);
    if (currentEvents.length === 0) {
      throw new ReevalCaseCommandError('case_not_initialized', `case ${root.caseId} has not been initialized`);
    }
    const existing = currentEvents.find((event) => event.eventId === command.eventId);
    const currentProjection = projectReevalCase(root, currentEvents);
    const attempted = commandToEvent(
      root,
      currentProjection,
      principal,
      command,
      existing?.occurredAt ?? this.now(),
      this.options.releaseTruth,
      existing,
    );
    if (existing) {
      requireMatchingDuplicate(existing, attempted);
      return { outcome: 'duplicate', projection: currentProjection };
    }

    const nextProjection = projectReevalCase(root, [...currentEvents, attempted]);
    const append = await this.options.eventLog.append(attempted, command.expectedSequence);
    if (append.outcome === 'appended') return { outcome: 'appended', projection: nextProjection };
    if (append.outcome === 'conflict') return append;

    const latestEvents = await this.options.eventLog.read(root.caseId);
    const raced = latestEvents.find((event) => event.eventId === command.eventId);
    if (!raced) {
      throw new ReevalCaseCommandError(
        'idempotency_collision',
        `eventId ${command.eventId} was consumed outside case ${root.caseId}`,
      );
    }
    const racedProjection = projectReevalCase(root, latestEvents);
    const racedAttempt = commandToEvent(
      root,
      racedProjection,
      principal,
      command,
      raced.occurredAt,
      this.options.releaseTruth,
      raced,
    );
    requireMatchingDuplicate(raced, racedAttempt);
    return { outcome: 'duplicate', projection: racedProjection };
  }
}
