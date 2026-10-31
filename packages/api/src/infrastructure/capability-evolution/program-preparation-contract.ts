import type {
  CallbackPrincipal,
  CatId,
  EvolutionPreparationBodyV1,
  EvolutionPreparationSection,
  EvolutionPreparationSubmissionRefV1,
  EvolutionPreparationSubmissionV1,
  EvolutionProgramEventEnvelopeV1,
} from '@cat-cafe/shared';
import { evolutionPreparationSubmissionRefV1Schema } from '@cat-cafe/shared';
import type { IMessageStore, StoredMessage } from '../../domains/cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../../domains/cats/services/stores/ports/ThreadStore.js';
import type { PreparationEvidenceRead } from './read-model/program-preparation-evidence.js';
import type { PreparationInputSource } from './read-model/program-preparation-inputs.js';

export type EvolutionPreparationInvocationPrincipal = Extract<CallbackPrincipal, { kind: 'invocation' }>;

export interface EvolutionPreparationInvocationRecord {
  invocationId: string;
  userId: string;
  catId: CatId;
  threadId: string;
  state: string;
  originTriggerMessageId?: string;
}

export interface EvolutionPreparationDependencies {
  messageStore: Pick<IMessageStore, 'appendIdempotent' | 'getByIdempotencyKey' | 'getById'>;
  threadStore: Pick<IThreadStore, 'get'>;
  invocationReader: {
    peekRecord(invocationId: string): Promise<EvolutionPreparationInvocationRecord | null>;
  };
  /** Optional live projection; the F117 message remains canonical when WebSocket delivery retries. */
  publishMessage?: (message: StoredMessage) => void | Promise<void>;
}

export interface BeginEvolutionPreparationWorkInput {
  programId: string;
  expectedSequence: number;
  clientMessageId: string;
  principal: EvolutionPreparationInvocationPrincipal;
  section: EvolutionPreparationSection;
  itemId?: string;
  focus: string;
  expectedCurrentSubmissionRef: EvolutionPreparationSubmissionRefV1 | null;
}

export interface SubmitEvolutionPreparationInput {
  programId: string;
  expectedSequence: number;
  clientMessageId: string;
  principal: EvolutionPreparationInvocationPrincipal;
  section: EvolutionPreparationSection;
  title: string;
  expectedCurrentSubmissionRef: EvolutionPreparationSubmissionRefV1 | null;
  dependsOn: EvolutionPreparationSubmissionRefV1[];
  body: EvolutionPreparationBodyV1;
}

export type EvolutionPreparationSourceStatus =
  | 'materializing'
  | 'submitted'
  | 'needs_update'
  | 'source_unavailable'
  | 'source_invalid';

export type EvolutionPreparationActivityState =
  | 'active'
  | 'terminal'
  | 'unknown'
  | 'identity_invalid'
  | 'superseded_by_submission';

export interface EvolutionPreparationSubmissionProjectionV1 {
  ref: EvolutionPreparationSubmissionRefV1;
  section: EvolutionPreparationSection;
  status: EvolutionPreparationSourceStatus;
  occurredAt: string;
  clientMessageId: string;
  threadId?: string;
  authorCatId?: string;
  messageId?: string;
  sourceMessageId?: string;
  dependencies: EvolutionPreparationSubmissionRefV1[];
  staleDependencies: EvolutionPreparationSubmissionRefV1[];
  submission?: EvolutionPreparationSubmissionV1;
  inputSources?: PreparationInputSource[];
  evidenceSources?: PreparationEvidenceRead[];
}

export interface EvolutionPreparationActivityProjectionV1 {
  activityRef: { ownerFeatureId: 'F167'; ownerStateRef: string };
  section: EvolutionPreparationSection;
  itemId?: string;
  focus: string;
  baseSubmissionRef?: EvolutionPreparationSubmissionRefV1;
  occurredAt: string;
  state: EvolutionPreparationActivityState;
  spinning: boolean;
  invocationId: string;
  threadId?: string;
  catId?: string;
}

export interface EvolutionPreparationSectionProjectionV1 {
  section: EvolutionPreparationSection;
  identityRef: { ownerFeatureId: 'F311'; ownerStateRef: string };
  current: EvolutionPreparationSubmissionProjectionV1 | null;
  history: EvolutionPreparationSubmissionProjectionV1[];
  activities: EvolutionPreparationActivityProjectionV1[];
}

export interface EvolutionPreparationProjectionV1 {
  schemaVersion: 1;
  programId: string;
  sections: Record<EvolutionPreparationSection, EvolutionPreparationSectionProjectionV1>;
}

export type EvolutionPreparationServiceErrorCode =
  | 'program_not_found'
  | 'preparation_unavailable'
  | 'preparation_actor_invalid'
  | 'preparation_actor_inactive'
  | 'preparation_source_unavailable'
  | 'preparation_revision_conflict'
  | 'preparation_dependency_conflict'
  | 'idempotency_collision'
  | 'invalid_command';

export class EvolutionPreparationServiceError extends Error {
  constructor(
    readonly code: EvolutionPreparationServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'EvolutionPreparationServiceError';
  }
}

export interface PreparationEventCoordinates {
  threadId: string;
  invocationId: string;
  clientMessageId: string;
}

export function parsePreparationEventOrigin(originRef: string): PreparationEventCoordinates | undefined {
  const match = /^thread:([A-Za-z0-9_-]+):invocation:([^:\s]+):message:(.+)$/.exec(originRef);
  if (!match) return undefined;
  return { threadId: match[1] as string, invocationId: match[2] as string, clientMessageId: match[3] as string };
}

export function preparationActorCatId(actorRef: string): string | undefined {
  return /^cat:([a-z0-9][a-z0-9._-]*)$/.exec(actorRef)?.[1];
}

export function preparationOwnerUserId(workspaceId: string): string | undefined {
  const userId = /^user:(.+)$/.exec(workspaceId)?.[1];
  return userId && userId.trim() === userId ? userId : undefined;
}

export function preparationSubmissionIdentity(programId: string, section: EvolutionPreparationSection): string {
  return `preparation-submission:${programId}:${section}`;
}

export function preparationSubmissionRef(
  programId: string,
  section: EvolutionPreparationSection,
  revision: string,
): EvolutionPreparationSubmissionRefV1 {
  return evolutionPreparationSubmissionRefV1Schema.parse({
    ownerFeatureId: 'F311',
    ownerStateRef: preparationSubmissionIdentity(programId, section),
    version: revision,
  });
}

export function preparationMaterializationKey(programId: string, clientMessageId: string): string {
  return `evolution-preparation:${programId}:${clientMessageId}`;
}

export function preparationCurrentRefs(
  events: readonly EvolutionProgramEventEnvelopeV1[],
): Map<EvolutionPreparationSection, EvolutionPreparationSubmissionRefV1> {
  const current = new Map<EvolutionPreparationSection, EvolutionPreparationSubmissionRefV1>();
  for (const envelope of events) {
    if (envelope.event.type === 'preparation_submission_committed') {
      current.set(envelope.event.section, envelope.event.submissionRef);
    }
  }
  return current;
}

export function preparationRefsEqual(
  left: EvolutionPreparationSubmissionRefV1 | null | undefined,
  right: EvolutionPreparationSubmissionRefV1 | null | undefined,
): boolean {
  if (!left || !right) return left == null && right == null;
  return (
    left.ownerFeatureId === right.ownerFeatureId &&
    left.ownerStateRef === right.ownerStateRef &&
    left.version === right.version
  );
}

export function sortPreparationRefs(
  refs: readonly EvolutionPreparationSubmissionRefV1[],
): EvolutionPreparationSubmissionRefV1[] {
  return [...refs].sort((left, right) => {
    const identity = left.ownerStateRef.localeCompare(right.ownerStateRef);
    return identity === 0 ? (left.version ?? '').localeCompare(right.version ?? '') : identity;
  });
}
