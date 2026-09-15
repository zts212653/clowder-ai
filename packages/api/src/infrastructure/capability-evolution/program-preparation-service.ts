import {
  type EvolutionPreparationSubmissionRefV1,
  type EvolutionProgramEventEnvelopeV1,
  type EvolutionProgramEventV1,
  evolutionPreparationSubmissionRefCoordinates,
  evolutionPreparationSubmissionV1Schema,
} from '@cat-cafe/shared';
import { deriveEvolutionPreparationSubmissionRevision } from '../../domains/cats/services/stores/ports/MessageStore.js';
import type { EvolutionProgramServiceResult } from './program-command-contract.js';
import { EvolutionProgramEventAppender } from './program-event-appender.js';
import { buildEvolutionProgramEnvelope, type IEvolutionProgramEventLog } from './program-event-log.js';
import {
  type BeginEvolutionPreparationWorkInput,
  type EvolutionPreparationDependencies,
  EvolutionPreparationServiceError,
  preparationCurrentRefs,
  preparationRefsEqual,
  preparationSubmissionRef,
  type SubmitEvolutionPreparationInput,
  sortPreparationRefs,
} from './program-preparation-contract.js';
import {
  assertPreparationMaterializationAvailable,
  materializePreparationSubmission,
} from './program-preparation-materialization.js';
import { projectEvolutionPreparation } from './program-preparation-projection.js';
import { stableId } from './program-service-options.js';
import { assertPreparationInputs } from './read-model/program-preparation-inputs.js';
import type { EvolutionProgramProjectionV1 } from './read-model/program-projection.js';

export type EvolutionPreparationMutationResult =
  | { outcome: 'appended' | 'duplicate' | 'recovered'; projection: EvolutionProgramProjectionV1 }
  | { outcome: 'conflict'; actualSequence: number; projection: EvolutionProgramProjectionV1 };

export interface EvolutionProgramPreparationServiceOptions {
  eventLog: IEvolutionProgramEventLog;
  projectProgram: (events: readonly EvolutionProgramEventEnvelopeV1[]) => EvolutionProgramProjectionV1;
  dependencies: EvolutionPreparationDependencies;
  now?: () => string;
}

function requireExpectedCurrentRef(
  programId: string,
  section: SubmitEvolutionPreparationInput['section'],
  expected: EvolutionPreparationSubmissionRefV1 | null,
): void {
  if (!expected) return;
  const coordinates = evolutionPreparationSubmissionRefCoordinates(expected);
  if (!coordinates || coordinates.programId !== programId || coordinates.section !== section) {
    throw new EvolutionPreparationServiceError(
      'invalid_command',
      'expectedCurrentSubmissionRef must name this Program and section',
    );
  }
}

function assertCurrentFence(
  events: readonly EvolutionProgramEventEnvelopeV1[],
  input: Pick<SubmitEvolutionPreparationInput, 'programId' | 'section' | 'expectedCurrentSubmissionRef'>,
): void {
  requireExpectedCurrentRef(input.programId, input.section, input.expectedCurrentSubmissionRef);
  const current = preparationCurrentRefs(events).get(input.section) ?? null;
  if (!preparationRefsEqual(current, input.expectedCurrentSubmissionRef)) {
    throw new EvolutionPreparationServiceError(
      'preparation_revision_conflict',
      'the preparation section advanced; read the exact current revision before writing',
    );
  }
}

function assertCurrentDependencies(
  events: readonly EvolutionProgramEventEnvelopeV1[],
  input: Pick<SubmitEvolutionPreparationInput, 'programId' | 'section' | 'dependsOn'>,
): void {
  const current = preparationCurrentRefs(events);
  for (const dependency of input.dependsOn) {
    const coordinates = evolutionPreparationSubmissionRefCoordinates(dependency);
    if (
      !coordinates ||
      coordinates.programId !== input.programId ||
      coordinates.section === input.section ||
      !preparationRefsEqual(current.get(coordinates.section), dependency)
    ) {
      throw new EvolutionPreparationServiceError(
        'preparation_dependency_conflict',
        'a preparation dependency is not the exact current revision in this Program',
      );
    }
  }
}

function existingIdentity(
  events: readonly EvolutionProgramEventEnvelopeV1[],
  envelope: EvolutionProgramEventEnvelopeV1,
): EvolutionProgramEventEnvelopeV1 | undefined {
  return events.find(
    (candidate) => candidate.eventId === envelope.eventId || candidate.clientMessageId === envelope.clientMessageId,
  );
}

export class EvolutionProgramPreparationService {
  private readonly now: () => string;
  private readonly appender: EvolutionProgramEventAppender;

  constructor(private readonly options: EvolutionProgramPreparationServiceOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.appender = new EvolutionProgramEventAppender(options.eventLog, (events) => this.projectBase(events));
  }

  async get(programId: string): Promise<EvolutionProgramProjectionV1> {
    return this.projectDetail(await this.options.eventLog.read(programId));
  }

  async beginPreparationWork(input: BeginEvolutionPreparationWorkInput): Promise<EvolutionProgramServiceResult> {
    const { events, projection, record } = await this.requireActiveActor(input);
    const event: EvolutionProgramEventV1 = {
      type: 'preparation_work_registered',
      section: input.section,
      ...(input.itemId ? { itemId: input.itemId } : {}),
      focus: input.focus,
      activityRef: { ownerFeatureId: 'F167', ownerStateRef: `invocation:${record.invocationId}` },
      ...(input.expectedCurrentSubmissionRef ? { baseSubmissionRef: input.expectedCurrentSubmissionRef } : {}),
    };
    const envelope = this.envelope(input, event);
    if (!existingIdentity(events, envelope)) {
      assertCurrentFence(events, input);
      this.assertWritable(projection);
    }
    const result = await this.appender.appendValidated(envelope);
    return this.withDetail(input.programId, result);
  }

  async submitPreparation(input: SubmitEvolutionPreparationInput): Promise<EvolutionPreparationMutationResult> {
    const { events, projection, record } = await this.requireActiveActor(input);
    const dependsOn = sortPreparationRefs(input.dependsOn);
    const draft = {
      schemaVersion: 1 as const,
      programId: input.programId,
      section: input.section,
      title: input.title,
      authorCatId: record.catId,
      dependsOn,
      body: input.body,
    };
    const submission = evolutionPreparationSubmissionV1Schema.parse({
      ...draft,
      revision: deriveEvolutionPreparationSubmissionRevision(draft),
    });
    const event: EvolutionProgramEventV1 = {
      type: 'preparation_submission_committed',
      section: input.section,
      submissionRef: preparationSubmissionRef(input.programId, input.section, submission.revision),
      dependencies: dependsOn,
    };
    const envelope = this.envelope(input, event);
    const committed = existingIdentity(events, envelope);
    if (
      committed &&
      (committed.event.type !== 'preparation_submission_committed' ||
        !preparationRefsEqual(committed.event.submissionRef, event.submissionRef))
    ) {
      throw new EvolutionPreparationServiceError(
        'idempotency_collision',
        'preparation recovery must materialize the exact committed submission',
      );
    }
    if (!committed) {
      // Only new intent needs current input availability; replay is pinned to its committed body.
      await assertPreparationInputs(submission.body, record.userId, this.options.dependencies);
      assertCurrentFence(events, input);
      assertCurrentDependencies(events, { ...input, dependsOn });
      this.assertWritable(projection);
      await assertPreparationMaterializationAvailable({
        dependencies: this.options.dependencies,
        envelope,
        submission,
        ownerUserId: record.userId,
      });
    }
    const append = await this.appender.appendValidated(envelope);
    if (append.outcome === 'conflict') return this.withDetail(input.programId, append);
    const created = await materializePreparationSubmission({
      dependencies: this.options.dependencies,
      envelope: committed ?? envelope,
      submission,
      ownerUserId: record.userId,
      originTriggerMessageId: record.originTriggerMessageId,
    });
    const detailed = await this.get(input.programId);
    return append.outcome === 'duplicate' && created
      ? { outcome: 'recovered', projection: detailed }
      : { outcome: append.outcome, projection: detailed };
  }

  private async requireActiveActor(input: Pick<BeginEvolutionPreparationWorkInput, 'programId' | 'principal'>) {
    const events = await this.options.eventLog.read(input.programId);
    const projection = this.projectBase(events);
    if (projection.program.workspaceId !== `user:${input.principal.userId}`) {
      throw new EvolutionPreparationServiceError('program_not_found', 'Evolution Program not found');
    }
    const record = await this.options.dependencies.invocationReader.peekRecord(input.principal.invocationId);
    if (
      !record ||
      record.invocationId !== input.principal.invocationId ||
      record.userId !== input.principal.userId ||
      record.catId !== input.principal.catId ||
      record.threadId !== input.principal.threadId
    ) {
      throw new EvolutionPreparationServiceError(
        'preparation_actor_invalid',
        'preparation work requires the exact authenticated invocation identity',
      );
    }
    if (record.state !== 'active') {
      throw new EvolutionPreparationServiceError(
        'preparation_actor_inactive',
        'preparation work requires an active invocation',
      );
    }
    const thread = await this.options.dependencies.threadStore.get(record.threadId);
    if (!thread || thread.deletedAt) {
      throw new EvolutionPreparationServiceError(
        'preparation_source_unavailable',
        'the authenticated preparation thread is unavailable',
      );
    }
    if (thread.createdBy !== record.userId) {
      throw new EvolutionPreparationServiceError(
        'preparation_actor_invalid',
        'the authenticated invocation is outside the thread owner workspace',
      );
    }
    return { events, projection, record };
  }

  private assertWritable(projection: EvolutionProgramProjectionV1): void {
    if (
      projection.program.lifecycle !== 'active' ||
      !['constituting', 'instrumenting', 'observing'].includes(projection.program.stage)
    ) {
      throw new EvolutionPreparationServiceError(
        'invalid_command',
        'preparation writes are closed for this Program lifecycle or stage',
      );
    }
  }

  private envelope(
    input: Pick<BeginEvolutionPreparationWorkInput, 'programId' | 'expectedSequence' | 'clientMessageId' | 'principal'>,
    event: EvolutionProgramEventV1,
  ): EvolutionProgramEventEnvelopeV1 {
    return buildEvolutionProgramEnvelope({
      programId: input.programId,
      expectedSequence: input.expectedSequence,
      clientMessageId: input.clientMessageId,
      actorRef: `cat:${input.principal.catId}`,
      originRef: `thread:${input.principal.threadId}:invocation:${input.principal.invocationId}:message:${input.clientMessageId}`,
      event,
      occurredAt: this.now(),
      eventId: stableId('evolution-event', input.programId, input.clientMessageId, event.type),
    });
  }

  private projectBase(events: readonly EvolutionProgramEventEnvelopeV1[]): EvolutionProgramProjectionV1 {
    return this.options.projectProgram(events);
  }

  private async projectDetail(events: readonly EvolutionProgramEventEnvelopeV1[]) {
    const projection = this.projectBase(events);
    return {
      ...projection,
      preparation: await projectEvolutionPreparation({
        events,
        program: projection.program,
        dependencies: this.options.dependencies,
      }),
    };
  }

  private async withDetail(programId: string, result: EvolutionProgramServiceResult) {
    return { ...result, projection: await this.get(programId) };
  }
}
