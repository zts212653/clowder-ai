import {
  EVOLUTION_PREPARATION_SECTIONS,
  type EvolutionPreparationSection,
  type EvolutionPreparationSubmissionRefV1,
  type EvolutionProgramEventEnvelopeV1,
  type EvolutionProgramV1,
  evolutionPreparationSubmissionRefCoordinates,
  evolutionPreparationSubmissionV1Schema,
} from '@cat-cafe/shared';
import {
  canonicalGrowingSourceJson,
  deriveEvolutionPreparationSubmissionRevision,
  isDelivered,
  type StoredMessage,
} from '../../domains/cats/services/stores/ports/MessageStore.js';
import type { Thread } from '../../domains/cats/services/stores/ports/ThreadStore.js';
import {
  type EvolutionPreparationActivityProjectionV1,
  type EvolutionPreparationDependencies,
  type EvolutionPreparationProjectionV1,
  type EvolutionPreparationSubmissionProjectionV1,
  parsePreparationEventOrigin,
  preparationActorCatId,
  preparationCurrentRefs,
  preparationMaterializationKey,
  preparationOwnerUserId,
  preparationRefsEqual,
  preparationSubmissionIdentity,
  sortPreparationRefs,
} from './program-preparation-contract.js';
import { readPreparationEvidence } from './read-model/program-preparation-evidence.js';
import { readPreparationInputs } from './read-model/program-preparation-inputs.js';

const TERMINAL_INVOCATION_STATES = new Set(['completed', 'failed', 'interrupted', 'replaced', 'revoked', 'canceled']);

function refsMatch(
  left: readonly EvolutionPreparationSubmissionRefV1[],
  right: readonly EvolutionPreparationSubmissionRefV1[],
): boolean {
  return (
    canonicalGrowingSourceJson(sortPreparationRefs(left)) === canonicalGrowingSourceJson(sortPreparationRefs(right))
  );
}

export function validPreparationSubmissionMessage(input: {
  message: StoredMessage;
  ownerUserId: string;
  threadId: string;
  authorCatId: string;
  programId: string;
  section: EvolutionPreparationSection;
  submissionRef: EvolutionPreparationSubmissionRefV1;
  dependencies: EvolutionPreparationSubmissionRefV1[];
}) {
  const { message } = input;
  if (
    message.userId !== input.ownerUserId ||
    message.threadId !== input.threadId ||
    message.catId !== input.authorCatId ||
    message.origin !== 'callback' ||
    message.source !== undefined ||
    message.sourceParseFailure === true ||
    !isDelivered(message) ||
    message.visibility === 'whisper'
  ) {
    return undefined;
  }
  const parsed = evolutionPreparationSubmissionV1Schema.safeParse(message.extra?.evolutionPreparationSubmissionV1);
  if (!parsed.success) return undefined;
  const submission = parsed.data;
  const { revision, ...draft } = submission;
  if (
    submission.programId !== input.programId ||
    submission.section !== input.section ||
    submission.authorCatId !== input.authorCatId ||
    revision !== input.submissionRef.version ||
    deriveEvolutionPreparationSubmissionRevision(draft) !== revision ||
    !refsMatch(submission.dependsOn, input.dependencies)
  ) {
    return undefined;
  }
  return submission;
}

function cacheRead<Key, Value>(cache: Map<Key, Promise<Value>>, key: Key, read: () => Promise<Value>): Promise<Value> {
  const existing = cache.get(key);
  if (existing) return existing;
  const pending = read();
  cache.set(key, pending);
  return pending;
}

function eventSourceIdentity(
  origin: ReturnType<typeof parsePreparationEventOrigin>,
  authorCatId: string | undefined,
  ownerUserId: string | undefined,
  clientMessageId: string,
): { origin: NonNullable<typeof origin>; authorCatId: string; ownerUserId: string } | undefined {
  return origin && authorCatId && ownerUserId && origin.clientMessageId === clientMessageId
    ? { origin, authorCatId, ownerUserId }
    : undefined;
}

function messageSource(message: StoredMessage): { valid: boolean; sourceMessageId?: string } {
  const causal = message.extra?.causal?.triggerMessageId;
  if (causal && message.replyTo && causal !== message.replyTo) return { valid: false };
  const sourceMessageId = causal ?? message.replyTo;
  return sourceMessageId ? { valid: true, sourceMessageId } : { valid: true };
}

async function projectSubmission(input: {
  envelope: EvolutionProgramEventEnvelopeV1 & {
    event: Extract<EvolutionProgramEventEnvelopeV1['event'], { type: 'preparation_submission_committed' }>;
  };
  program: EvolutionProgramV1;
  dependencies: EvolutionPreparationDependencies;
  currentRefs: Map<EvolutionPreparationSection, EvolutionPreparationSubmissionRefV1>;
  messageCache: Map<string, Promise<StoredMessage | null>>;
  threadCache: Map<string, Promise<Thread | null>>;
}): Promise<EvolutionPreparationSubmissionProjectionV1> {
  const { envelope, program } = input;
  const event = envelope.event;
  const origin = parsePreparationEventOrigin(envelope.originRef);
  const authorCatId = preparationActorCatId(envelope.actorRef);
  const ownerUserId = preparationOwnerUserId(program.workspaceId);
  const staleDependencies = event.dependencies.filter((dependency) => {
    const coordinates = evolutionPreparationSubmissionRefCoordinates(dependency);
    return !coordinates || !preparationRefsEqual(input.currentRefs.get(coordinates.section), dependency);
  });
  const base = {
    ref: event.submissionRef,
    section: event.section,
    occurredAt: envelope.occurredAt,
    clientMessageId: envelope.clientMessageId,
    dependencies: event.dependencies,
    staleDependencies,
    ...(origin ? { threadId: origin.threadId } : {}),
    ...(authorCatId ? { authorCatId } : {}),
  };
  const sourceIdentity = eventSourceIdentity(origin, authorCatId, ownerUserId, envelope.clientMessageId);
  if (!sourceIdentity) {
    return { ...base, status: 'source_invalid' };
  }
  const validOrigin = sourceIdentity.origin;

  const thread = await cacheRead(input.threadCache, validOrigin.threadId, () =>
    Promise.resolve(input.dependencies.threadStore.get(validOrigin.threadId)),
  );
  if (!thread || thread.deletedAt) return { ...base, status: 'source_unavailable' };
  if (thread.createdBy !== sourceIdentity.ownerUserId) return { ...base, status: 'source_invalid' };

  const key = preparationMaterializationKey(envelope.programId, envelope.clientMessageId);
  const message = await cacheRead(input.messageCache, key, () =>
    Promise.resolve(
      input.dependencies.messageStore.getByIdempotencyKey(sourceIdentity.ownerUserId, validOrigin.threadId, key),
    ),
  );
  if (!message) return { ...base, status: 'materializing' };
  if (message.deletedAt || message._tombstone || message.recall) {
    return { ...base, status: 'source_unavailable', messageId: message.id };
  }
  const submission = validPreparationSubmissionMessage({
    message,
    ownerUserId: sourceIdentity.ownerUserId,
    threadId: validOrigin.threadId,
    authorCatId: sourceIdentity.authorCatId,
    programId: program.programId,
    section: event.section,
    submissionRef: event.submissionRef,
    dependencies: event.dependencies,
  });
  if (!submission) return { ...base, status: 'source_invalid', messageId: message.id };
  const source = messageSource(message);
  if (!source.valid) {
    return { ...base, status: 'source_invalid', messageId: message.id };
  }
  return {
    ...base,
    status: staleDependencies.length > 0 ? 'needs_update' : 'submitted',
    messageId: message.id,
    ...(source.sourceMessageId ? { sourceMessageId: source.sourceMessageId } : {}),
    submission,
    inputSources: await readPreparationInputs(submission.body, sourceIdentity.ownerUserId, input.dependencies),
    evidenceSources: await readPreparationEvidence(submission.body, sourceIdentity.ownerUserId, input.dependencies),
  };
}

async function projectActivity(input: {
  envelope: EvolutionProgramEventEnvelopeV1 & {
    event: Extract<EvolutionProgramEventEnvelopeV1['event'], { type: 'preparation_work_registered' }>;
  };
  superseded: boolean;
  ownerUserId: string | undefined;
  dependencies: EvolutionPreparationDependencies;
  invocationCache: Map<
    string,
    Promise<Awaited<ReturnType<EvolutionPreparationDependencies['invocationReader']['peekRecord']>>>
  >;
  threadCache: Map<string, Promise<Thread | null>>;
}): Promise<EvolutionPreparationActivityProjectionV1> {
  const { envelope, superseded } = input;
  const origin = parsePreparationEventOrigin(envelope.originRef);
  const catId = preparationActorCatId(envelope.actorRef);
  const invocationId = envelope.event.activityRef.ownerStateRef.slice('invocation:'.length);
  const base = {
    activityRef: {
      ownerFeatureId: 'F167' as const,
      ownerStateRef: envelope.event.activityRef.ownerStateRef,
    },
    section: envelope.event.section,
    ...(envelope.event.itemId ? { itemId: envelope.event.itemId } : {}),
    focus: envelope.event.focus,
    ...(envelope.event.baseSubmissionRef ? { baseSubmissionRef: envelope.event.baseSubmissionRef } : {}),
    occurredAt: envelope.occurredAt,
    invocationId,
    ...(origin ? { threadId: origin.threadId } : {}),
  };
  if (
    !origin ||
    !catId ||
    !input.ownerUserId ||
    origin.invocationId !== invocationId ||
    origin.clientMessageId !== envelope.clientMessageId
  ) {
    return { ...base, state: 'identity_invalid', spinning: false };
  }
  const [record, thread] = await Promise.all([
    cacheRead(input.invocationCache, invocationId, () => input.dependencies.invocationReader.peekRecord(invocationId)),
    cacheRead(input.threadCache, origin.threadId, () =>
      Promise.resolve(input.dependencies.threadStore.get(origin.threadId)),
    ),
  ]);
  if (!record) return { ...base, state: 'unknown', spinning: false };
  if (
    !thread ||
    thread.deletedAt ||
    thread.createdBy !== input.ownerUserId ||
    record.invocationId !== invocationId ||
    record.userId !== input.ownerUserId ||
    record.catId !== catId ||
    record.threadId !== origin.threadId
  ) {
    return { ...base, state: 'identity_invalid', spinning: false };
  }
  const attributed = { ...base, catId };
  if (superseded) return { ...attributed, state: 'superseded_by_submission', spinning: false };
  if (record.state === 'active') return { ...attributed, state: 'active', spinning: true };
  if (TERMINAL_INVOCATION_STATES.has(record.state)) {
    return { ...attributed, state: 'terminal', spinning: false };
  }
  return { ...base, state: 'unknown', spinning: false };
}

export async function projectEvolutionPreparation(input: {
  events: readonly EvolutionProgramEventEnvelopeV1[];
  program: EvolutionProgramV1;
  dependencies: EvolutionPreparationDependencies;
}): Promise<EvolutionPreparationProjectionV1> {
  const currentRefs = preparationCurrentRefs(input.events);
  const messageCache = new Map<string, Promise<StoredMessage | null>>();
  const threadCache = new Map<string, Promise<Thread | null>>();
  const invocationCache = new Map<
    string,
    Promise<Awaited<ReturnType<EvolutionPreparationDependencies['invocationReader']['peekRecord']>>>
  >();
  const submissionEntries = input.events
    .map((envelope, index) => ({ envelope, index }))
    .filter(
      (
        entry,
      ): entry is typeof entry & {
        envelope: EvolutionProgramEventEnvelopeV1 & {
          event: Extract<EvolutionProgramEventEnvelopeV1['event'], { type: 'preparation_submission_committed' }>;
        };
      } => entry.envelope.event.type === 'preparation_submission_committed',
    );
  const workEntries = input.events
    .map((envelope, index) => ({ envelope, index }))
    .filter(
      (
        entry,
      ): entry is typeof entry & {
        envelope: EvolutionProgramEventEnvelopeV1 & {
          event: Extract<EvolutionProgramEventEnvelopeV1['event'], { type: 'preparation_work_registered' }>;
        };
      } => entry.envelope.event.type === 'preparation_work_registered',
    );
  const submissionViews = await Promise.all(
    submissionEntries.map((entry) =>
      projectSubmission({
        ...entry,
        program: input.program,
        dependencies: input.dependencies,
        currentRefs,
        messageCache,
        threadCache,
      }),
    ),
  );
  const ownerUserId = preparationOwnerUserId(input.program.workspaceId);
  const activityViews = await Promise.all(
    workEntries.map((entry) => {
      const key = entry.envelope.event.itemId ?? '__section__';
      const superseded =
        submissionEntries.some(
          (submission) =>
            submission.index > entry.index && submission.envelope.event.section === entry.envelope.event.section,
        ) ||
        workEntries.some(
          (work) =>
            work.index > entry.index &&
            work.envelope.event.section === entry.envelope.event.section &&
            (work.envelope.event.itemId ?? '__section__') === key,
        );
      return projectActivity({
        ...entry,
        superseded,
        ownerUserId,
        dependencies: input.dependencies,
        invocationCache,
        threadCache,
      });
    }),
  );

  const sections = Object.fromEntries(
    EVOLUTION_PREPARATION_SECTIONS.map((section) => {
      const submissions = submissionViews.filter((submission) => submission.section === section);
      const current = submissions.at(-1) ?? null;
      return [
        section,
        {
          section,
          identityRef: {
            ownerFeatureId: 'F311',
            ownerStateRef: preparationSubmissionIdentity(input.program.programId, section),
          },
          current,
          history: current ? submissions.slice(0, -1).reverse() : [],
          activities: activityViews.filter((activity) => activity.section === section).reverse(),
        },
      ];
    }),
  ) as EvolutionPreparationProjectionV1['sections'];
  return { schemaVersion: 1, programId: input.program.programId, sections };
}
