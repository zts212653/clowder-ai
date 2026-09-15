import {
  createCatId,
  type EvolutionProgramEventEnvelopeV1,
  evolutionPreparationSubmissionV1Schema,
} from '@cat-cafe/shared';
import { canonicalGrowingSourceJson } from '../../domains/cats/services/stores/ports/MessageStore.js';
import type { EvolutionPreparationDependencies } from './program-preparation-contract.js';
import {
  EvolutionPreparationServiceError,
  parsePreparationEventOrigin,
  preparationMaterializationKey,
} from './program-preparation-contract.js';
import { validPreparationSubmissionMessage } from './program-preparation-projection.js';

type Submission = ReturnType<typeof evolutionPreparationSubmissionV1Schema.parse>;

interface MaterializationInput {
  dependencies: EvolutionPreparationDependencies;
  envelope: EvolutionProgramEventEnvelopeV1;
  submission: Submission;
  ownerUserId: string;
  originTriggerMessageId?: string;
}

function coordinates(input: MaterializationInput) {
  const origin = parsePreparationEventOrigin(input.envelope.originRef);
  const event = input.envelope.event;
  if (
    !origin ||
    event.type !== 'preparation_submission_committed' ||
    origin.clientMessageId !== input.envelope.clientMessageId
  ) {
    throw new EvolutionPreparationServiceError('invalid_command', 'invalid preparation materialization intent');
  }
  if (input.envelope.actorRef !== `cat:${input.submission.authorCatId}`) {
    throw new EvolutionPreparationServiceError('preparation_actor_invalid', 'preparation author mismatch');
  }
  return {
    origin,
    event,
    idempotencyKey: preparationMaterializationKey(input.envelope.programId, input.envelope.clientMessageId),
  };
}

function assertExisting(
  input: MaterializationInput,
  message: NonNullable<Awaited<ReturnType<EvolutionPreparationDependencies['messageStore']['getById']>>>,
) {
  const { origin, event } = coordinates(input);
  const valid =
    !message.deletedAt &&
    !message._tombstone &&
    !message.recall &&
    validPreparationSubmissionMessage({
      message,
      ownerUserId: input.ownerUserId,
      threadId: origin.threadId,
      authorCatId: input.submission.authorCatId,
      programId: input.envelope.programId,
      section: event.section,
      submissionRef: event.submissionRef,
      dependencies: event.dependencies,
    });
  if (!valid || canonicalGrowingSourceJson(valid) !== canonicalGrowingSourceJson(input.submission)) {
    throw new EvolutionPreparationServiceError(
      'idempotency_collision',
      'the preparation materialization identity is already bound to different or unavailable content',
    );
  }
}

export async function assertPreparationMaterializationAvailable(input: MaterializationInput): Promise<void> {
  const { origin, idempotencyKey } = coordinates(input);
  const existing = await input.dependencies.messageStore.getByIdempotencyKey(
    input.ownerUserId,
    origin.threadId,
    idempotencyKey,
  );
  if (existing) assertExisting(input, existing);
}

export async function materializePreparationSubmission(input: MaterializationInput): Promise<boolean> {
  const { origin, idempotencyKey } = coordinates(input);
  const existing = await input.dependencies.messageStore.getByIdempotencyKey(
    input.ownerUserId,
    origin.threadId,
    idempotencyKey,
  );
  if (existing) {
    assertExisting(input, existing);
    await input.dependencies.publishMessage?.(existing);
    return false;
  }
  const result = await input.dependencies.messageStore.appendIdempotent({
    userId: input.ownerUserId,
    threadId: origin.threadId,
    catId: createCatId(input.submission.authorCatId),
    content: `准备提交 · ${input.submission.title}\n${input.submission.body.summary}`,
    mentions: [],
    timestamp: Date.parse(input.envelope.occurredAt),
    origin: 'callback',
    idempotencyKey,
    ...(input.originTriggerMessageId
      ? {
          replyTo: input.originTriggerMessageId,
          extra: {
            isExplicitPost: true,
            stream: { invocationId: origin.invocationId, turnInvocationId: origin.invocationId },
            causal: { kind: 'invocation_reply' as const, triggerMessageId: input.originTriggerMessageId },
            evolutionPreparationSubmissionV1: input.submission,
          },
        }
      : {
          extra: {
            isExplicitPost: true,
            stream: { invocationId: origin.invocationId, turnInvocationId: origin.invocationId },
            evolutionPreparationSubmissionV1: input.submission,
          },
        }),
  });
  assertExisting(input, result.message);
  await input.dependencies.publishMessage?.(result.message);
  return !result.idempotent;
}
