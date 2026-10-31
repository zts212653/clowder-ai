import { z } from 'zod';
import { projectReevalClosure, type ReevalClosureProjection, type ReevalClosureRoot } from './reeval-closure.js';
import { assertLifecycleBootstrapPrefix } from './reeval-closure-bootstrap.js';
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

export const ReevalClosureCommandSchema = z.discriminatedUnion('type', [
  commandBaseSchema.extend({ type: z.literal('reassign_owner'), targetOwnerCatId: nonEmptyString }).strict(),
  plainCommand('acknowledge'),
  plainCommand('plan_action'),
  plainCommand('record_fix'),
  plainCommand('request_reeval'),
  commandBaseSchema.extend({ type: z.literal('record_reeval_result'), result: z.enum(['passed', 'failed']) }).strict(),
  plainCommand('suppress'),
]);

export type ReevalClosureCommand = z.infer<typeof ReevalClosureCommandSchema>;

export type ReevalClosureCommandErrorCode =
  | 'invalid_command'
  | 'invalid_principal'
  | 'root_not_found'
  | 'bootstrap_unavailable'
  | 'eval_authority_unavailable'
  | 'reeval_sla_unavailable'
  | 'idempotency_collision';

export class ReevalClosureCommandError extends Error {
  constructor(
    readonly code: ReevalClosureCommandErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ReevalClosureCommandError';
  }
}

export type ReevalClosureCommandResult =
  | { outcome: 'appended' | 'duplicate'; projection: ReevalClosureProjection }
  | Extract<ReevalClosureAppendResult, { outcome: 'conflict' }>;

export interface ReevalClosureServiceOptions {
  eventLog: IReevalClosureEventLog;
  loadRoot: (verdictId: string) => Promise<ReevalClosureRoot | null | undefined>;
  loadBootstrap: (verdictId: string) => Promise<readonly EvalLifecycleEvent[] | null | undefined>;
  now?: () => string;
}

async function materializeLifecycleBootstrap(
  eventLog: IReevalClosureEventLog,
  verdictId: string,
  bootstrap: readonly EvalLifecycleEvent[],
): Promise<EvalLifecycleEvent[]> {
  if (bootstrap.length === 0) {
    throw new ReevalClosureCommandError(
      'bootstrap_unavailable',
      `no canonical lifecycle bootstrap is available for verdict ${verdictId}`,
    );
  }

  let events = await eventLog.read(verdictId);
  assertLifecycleBootstrapPrefix(verdictId, events, bootstrap);
  while (events.length < bootstrap.length) {
    const sequence = events.length;
    await eventLog.append(bootstrap[sequence], sequence);
    const latest = await eventLog.read(verdictId);
    assertLifecycleBootstrapPrefix(verdictId, latest, bootstrap);
    if (latest.length <= sequence) {
      throw new ReevalClosureCommandError(
        'idempotency_collision',
        `bootstrap event ${bootstrap[sequence].eventId} was consumed outside lifecycle ${verdictId}`,
      );
    }
    events = latest;
  }
  return events;
}

function parsePrincipal(raw: unknown): EvalLifecycleActor {
  const parsed = EvalLifecycleActorSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ReevalClosureCommandError('invalid_principal', `invalid lifecycle principal: ${parsed.error.message}`);
  }
  return parsed.data;
}

function parseCommand(raw: unknown): ReevalClosureCommand {
  const parsed = ReevalClosureCommandSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ReevalClosureCommandError('invalid_command', `invalid lifecycle command: ${parsed.error.message}`);
  }
  return parsed.data;
}

function deriveReevalDueAt(root: ReevalClosureRoot, occurredAt: string): string {
  const reevalWithinHours = root.reevalWithinHours;
  if (typeof reevalWithinHours !== 'number' || !Number.isInteger(reevalWithinHours) || reevalWithinHours <= 0) {
    throw new ReevalClosureCommandError(
      'reeval_sla_unavailable',
      `cannot request re-evaluation for ${root.verdictId} without a positive domain re-evaluation SLA`,
    );
  }
  return new Date(Date.parse(occurredAt) + reevalWithinHours * 3_600_000).toISOString();
}

function commandToEvent(
  root: ReevalClosureRoot,
  projection: ReevalClosureProjection,
  actor: EvalLifecycleActor,
  command: ReevalClosureCommand,
  occurredAt: string,
  existing?: EvalLifecycleEvent,
): EvalLifecycleEvent {
  const base = {
    eventId: command.eventId,
    verdictId: command.verdictId,
    domainId: root.domainId,
    actor,
    occurredAt,
    reason: command.reason,
    refs: command.refs,
  };

  switch (command.type) {
    case 'reassign_owner':
      return { ...base, type: 'owner_reassigned', targetOwnerCatId: command.targetOwnerCatId };
    case 'acknowledge':
      return { ...base, type: 'owner_acknowledged' };
    case 'plan_action':
      return { ...base, type: 'action_planned' };
    case 'record_fix':
      return { ...base, type: 'fix_recorded' };
    case 'request_reeval': {
      if (existing?.type === 'reeval_requested') {
        return {
          ...base,
          type: 'reeval_requested',
          dueAt: existing.dueAt,
          ...(existing.assignedEvalCatId ? { assignedEvalCatId: existing.assignedEvalCatId } : {}),
        };
      }
      if (root.assignedEvalCatId === undefined) {
        throw new ReevalClosureCommandError(
          'eval_authority_unavailable',
          `cannot request re-evaluation for ${root.verdictId} without an assigned eval cat`,
        );
      }
      return {
        ...base,
        type: 'reeval_requested',
        dueAt: deriveReevalDueAt(root, occurredAt),
        assignedEvalCatId: root.assignedEvalCatId,
      };
    }
    case 'record_reeval_result': {
      const resultType = command.result === 'passed' ? 'reeval_passed' : 'reeval_failed';
      const existingAssignment = existing?.type === resultType ? existing.assignedEvalCatId : undefined;
      const assignedEvalCatId = existingAssignment ?? projection.reevalAssignedCatId ?? root.assignedEvalCatId;
      if (assignedEvalCatId === undefined) {
        throw new ReevalClosureCommandError(
          'eval_authority_unavailable',
          `cannot record re-evaluation result for ${root.verdictId} without a trusted eval cat`,
        );
      }
      return { ...base, type: resultType, assignedEvalCatId };
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

function eventIntentFingerprint(event: EvalLifecycleEvent): string {
  const { occurredAt: _occurredAt, ...intent } = event;
  return JSON.stringify(canonicalize(intent));
}

function requireMatchingDuplicate(existing: EvalLifecycleEvent, attempted: EvalLifecycleEvent): void {
  if (eventIntentFingerprint(existing) !== eventIntentFingerprint(attempted)) {
    throw new ReevalClosureCommandError(
      'idempotency_collision',
      `eventId ${attempted.eventId} already belongs to a different lifecycle event`,
    );
  }
}

export class ReevalClosureService {
  private readonly now: () => string;

  constructor(private readonly options: ReevalClosureServiceOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async execute(rawPrincipal: unknown, rawCommand: unknown): Promise<ReevalClosureCommandResult> {
    const principal = parsePrincipal(rawPrincipal);
    const command = parseCommand(rawCommand);
    const root = await this.options.loadRoot(command.verdictId);
    if (root === undefined || root === null) {
      throw new ReevalClosureCommandError('root_not_found', `no lifecycle root for verdict ${command.verdictId}`);
    }

    const bootstrap = await this.options.loadBootstrap(command.verdictId);
    if (bootstrap === undefined || bootstrap === null) {
      throw new ReevalClosureCommandError(
        'bootstrap_unavailable',
        `no canonical lifecycle bootstrap is available for verdict ${command.verdictId}`,
      );
    }
    const currentEvents = await materializeLifecycleBootstrap(this.options.eventLog, command.verdictId, bootstrap);
    const expectedSequence =
      command.expectedSequence === 0 && currentEvents.length === bootstrap.length
        ? bootstrap.length
        : command.expectedSequence;
    const existing = currentEvents.find((event) => event.eventId === command.eventId);
    const currentProjection = projectReevalClosure(root, currentEvents);
    const attemptedEvent = commandToEvent(root, currentProjection, principal, command, this.now(), existing);
    if (existing !== undefined) {
      requireMatchingDuplicate(existing, attemptedEvent);
      return { outcome: 'duplicate', projection: projectReevalClosure(root, currentEvents) };
    }

    const nextProjection = projectReevalClosure(root, [...currentEvents, attemptedEvent]);
    const appendResult = await this.options.eventLog.append(attemptedEvent, expectedSequence);
    if (appendResult.outcome === 'appended') {
      return { outcome: 'appended', projection: nextProjection };
    }
    if (appendResult.outcome === 'conflict') return appendResult;

    const latestEvents = await this.options.eventLog.read(command.verdictId);
    const racedDuplicate = latestEvents.find((event) => event.eventId === command.eventId);
    if (racedDuplicate === undefined) {
      throw new ReevalClosureCommandError(
        'idempotency_collision',
        `eventId ${command.eventId} was already consumed by another verdict`,
      );
    }
    const latestProjection = projectReevalClosure(root, latestEvents);
    const racedAttemptedEvent = commandToEvent(
      root,
      latestProjection,
      principal,
      command,
      attemptedEvent.occurredAt,
      racedDuplicate,
    );
    requireMatchingDuplicate(racedDuplicate, racedAttemptedEvent);
    return { outcome: 'duplicate', projection: latestProjection };
  }
}
