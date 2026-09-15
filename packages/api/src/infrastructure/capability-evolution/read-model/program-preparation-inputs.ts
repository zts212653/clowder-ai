import type { EvolutionPreparationBodyV1 } from '@cat-cafe/shared';
import { isDelivered } from '../../../domains/cats/services/stores/ports/MessageStore.js';
import type { EvolutionPreparationDependencies } from '../program-preparation-contract.js';
import { EvolutionPreparationServiceError } from '../program-preparation-contract.js';

export interface PreparationInputSource {
  itemId: string;
  threadId: string;
  messageId: string;
  status: 'available' | 'unavailable';
  author?: 'human';
  occurredAt?: string;
}

/** Resolve the exact F117 human message, independently of any client-supplied provenance claim. */
export async function readPreparationInputs(
  body: EvolutionPreparationBodyV1,
  ownerUserId: string,
  dependencies: EvolutionPreparationDependencies,
): Promise<PreparationInputSource[]> {
  const items = body.kind === 'object_map' ? body.items : body.kind === 'measurement_plan' ? body.conditions : [];
  const inputs = items.flatMap((item) => {
    const decision = item.decision;
    if (!decision || decision.state === 'undecided' || !('input' in decision.responsibility)) return [];
    return [{ itemId: item.itemId, ...decision.responsibility.input }];
  });
  return Promise.all(
    inputs.map(async (input): Promise<PreparationInputSource> => {
      const [message, thread] = await Promise.all([
        dependencies.messageStore.getById(input.messageId),
        dependencies.threadStore.get(input.threadId),
      ]);
      if (
        !message ||
        !thread ||
        thread.deletedAt ||
        thread.createdBy !== ownerUserId ||
        message.threadId !== input.threadId ||
        message.userId !== ownerUserId ||
        message.catId !== null ||
        message.origin !== undefined ||
        message.source !== undefined ||
        message.sourceParseFailure === true ||
        message.deletedAt !== undefined ||
        message._tombstone ||
        message.recall ||
        !isDelivered(message) ||
        message.visibility === 'whisper'
      ) {
        return { ...input, status: 'unavailable' };
      }
      return { ...input, status: 'available', author: 'human', occurredAt: new Date(message.timestamp).toISOString() };
    }),
  );
}

export async function assertPreparationInputs(
  body: EvolutionPreparationBodyV1,
  ownerUserId: string,
  dependencies: EvolutionPreparationDependencies,
): Promise<void> {
  const inputs = await readPreparationInputs(body, ownerUserId, dependencies);
  if (inputs.some((input) => input.status !== 'available')) {
    throw new EvolutionPreparationServiceError(
      'preparation_actor_invalid',
      'a human decision requires available, same-workspace, authentic human input',
    );
  }
}
