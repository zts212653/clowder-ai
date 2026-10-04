import {
  type CollectiveReactionEmoji,
  type CollectiveReactionSummary,
  setCollectiveReactionRequestSchema,
} from '@cat-cafe/shared';
import { requireHumanCommand } from './collaboration-command-helpers.js';
import { collaborationOperationReplay, recordCollaborationOperation } from './collaboration-operations.js';
import { CollectiveServiceError } from './errors.js';
import { requireHumanAuthBinding, requireMembership, resolveSession } from './identity-store.js';
import { createStableId, type PersistentServiceState } from './persistence.js';
import type { ReactionRecord } from './service-records.js';
import type { MutableServiceState, ServiceState } from './state.js';

export class CollectiveReactionStore {
  constructor(
    private readonly persistence: PersistentServiceState,
    private readonly now: () => number,
  ) {}

  async set(sessionToken: string, unsafeInput: unknown): Promise<CollectiveReactionSummary> {
    const input = setCollectiveReactionRequestSchema.parse(unsafeInput);
    return this.persistence.transaction((state) => {
      const human = requireHumanCommand(state, sessionToken, input);
      requirePublicSource(state, input.collectiveId, input.eventId);
      const actorScope = `human:${human.humanId}`;
      const replay = collaborationOperationReplay(state, {
        ...input,
        actorScope,
        payload: input,
        resourceKind: 'reaction',
      });
      if (replay.existing) {
        requireReaction(state, replay.existing.resourceId);
        return reactionSummary(state, input.collectiveId, input.eventId, input.emoji);
      }

      const at = new Date(this.now()).toISOString();
      let reaction = findReaction(state, input.collectiveId, input.eventId, human.humanId, input.emoji);
      if (!reaction) {
        const reactionId = createStableId('reaction_');
        reaction = {
          v: 1,
          reactionId,
          serviceInstanceId: state.serviceInstanceId,
          collectiveId: input.collectiveId,
          eventId: input.eventId,
          emoji: input.emoji,
          humanId: human.humanId,
          active: input.active,
          revision: 1,
          createdAt: at,
          updatedAt: at,
          history: [{ revision: 1, active: input.active, at }],
        };
        state.reactions[reactionId] = reaction;
      } else if (reaction.active !== input.active) {
        reaction.active = input.active;
        reaction.revision += 1;
        reaction.updatedAt = at;
        reaction.history.push({ revision: reaction.revision, active: input.active, at });
      }
      recordCollaborationOperation(state, {
        ...replay,
        actorScope,
        resourceKind: 'reaction',
        resourceId: reaction.reactionId,
        revision: reaction.revision,
        recordedAt: at,
      });
      return reactionSummary(state, input.collectiveId, input.eventId, input.emoji);
    });
  }

  list(sessionToken: string, collectiveId: string): CollectiveReactionSummary[] {
    const state = this.persistence.snapshot();
    const { human } = resolveSession(state, sessionToken);
    requireHumanAuthBinding(state, human.humanId);
    requireMembership(state, collectiveId, human.humanId);
    const keys = new Map<string, { eventId: string; emoji: CollectiveReactionEmoji }>();
    for (const reaction of Object.values(state.reactions)) {
      if (reaction.collectiveId !== collectiveId || !reaction.active) continue;
      keys.set(`${reaction.eventId}\0${reaction.emoji}`, { eventId: reaction.eventId, emoji: reaction.emoji });
    }
    return [...keys.values()].map(({ eventId, emoji }) => reactionSummary(state, collectiveId, eventId, emoji));
  }
}

function requirePublicSource(state: ServiceState, collectiveId: string, eventId: string): void {
  const event = state.events[collectiveId]?.find((candidate) => candidate.eventId === eventId);
  if (!event?.location) {
    throw new CollectiveServiceError(
      'REACTION_SOURCE_UNAVAILABLE',
      'Reactions require an exact public Channel message',
      409,
    );
  }
}

function findReaction(
  state: MutableServiceState,
  collectiveId: string,
  eventId: string,
  humanId: string,
  emoji: CollectiveReactionEmoji,
): MutableServiceState['reactions'][string] | undefined {
  return Object.values(state.reactions).find(
    (reaction) =>
      reaction.collectiveId === collectiveId &&
      reaction.eventId === eventId &&
      reaction.humanId === humanId &&
      reaction.emoji === emoji,
  );
}

function requireReaction(state: ServiceState, reactionId: string): ReactionRecord {
  const reaction = state.reactions[reactionId];
  if (!reaction) throw new CollectiveServiceError('REACTION_NOT_FOUND', 'Reaction history was not found', 409);
  return reaction;
}

function reactionSummary(
  state: ServiceState,
  collectiveId: string,
  eventId: string,
  emoji: CollectiveReactionEmoji,
): CollectiveReactionSummary {
  return {
    serviceInstanceId: state.serviceInstanceId,
    collectiveId,
    eventId,
    emoji,
    humanIds: Object.values(state.reactions)
      .filter(
        (reaction) =>
          reaction.collectiveId === collectiveId &&
          reaction.eventId === eventId &&
          reaction.emoji === emoji &&
          reaction.active,
      )
      .map((reaction) => reaction.humanId),
  };
}
