import { createHash } from 'node:crypto';
import type { DevelopmentReturnRegistrationV1, TaskItem, ThreadProposal } from '@cat-cafe/shared';
import { readDurableLocalReviewFact } from '../../../domains/cats/services/local-review-artifact.js';
import type { DevelopmentWorkActor } from '../../../domains/cats/services/stores/ports/DevelopmentWorkTransition.js';
import {
  canonicalGrowingSourceJson,
  deriveGrowingSourceMessageRevision,
  type StoredMessage,
} from '../../../domains/cats/services/stores/ports/MessageStore.js';
import type { DevelopmentReturnDeps } from './DevelopmentReturnService.js';

type Deps = Pick<DevelopmentReturnDeps, 'tasks' | 'messages' | 'readReviewProvenance'>;

function currentOriginal(message: StoredMessage | null, actor: DevelopmentWorkActor): message is StoredMessage {
  return (
    !!message &&
    message.userId === actor.userId &&
    message.threadId === actor.threadId &&
    !message.deletedAt &&
    !message._tombstone &&
    !message.source
  );
}

async function hasHumanAuthority(deps: Deps, actor: DevelopmentWorkActor, task: TaskItem, source: StoredMessage) {
  const sourceRef = `message:${source.id}`;
  return (
    task.entrustedWork?.admission.sourceRefs.includes(sourceRef) ||
    (await deps.tasks.hasDevelopmentSource({
      actor,
      taskId: task.id,
      sourceRef,
      sourceRevision: deriveGrowingSourceMessageRevision(source),
    }))
  );
}

/** Resolve a relation, never infer an authorization from prose or a reviewer verdict. */
export async function resolveDevelopmentReturnSource(
  deps: Deps,
  actor: DevelopmentWorkActor,
  task: TaskItem,
  proposal: ThreadProposal,
  trigger: StoredMessage | null,
): Promise<{ sourceMessageRevision: string } | null> {
  if (!currentOriginal(trigger, actor)) return null;
  const sourceMessageRevision = deriveGrowingSourceMessageRevision(trigger);
  if (trigger.catId === null) {
    return (await hasHumanAuthority(deps, actor, task, trigger)) ? { sourceMessageRevision } : null;
  }
  const fact = readDurableLocalReviewFact(trigger);
  if (
    !fact ||
    fact.verdict !== 'approved' ||
    fact.reviewerCatId === actor.catId ||
    fact.reviewSubjectRef !== `task:work:${task.id}` ||
    fact.acceptedSourceRef !== `${actor.threadId}#${fact.acceptedRevision}` ||
    proposal.createdBy !== actor.userId ||
    proposal.approvedBy !== actor.userId ||
    proposal.approvedAt === undefined ||
    trigger.timestamp > proposal.approvedAt
  )
    return null;
  if (!deps.readReviewProvenance) throw new Error('Recorded review provenance reader is unavailable');
  const provenance = await deps.readReviewProvenance({
    userId: actor.userId,
    threadId: actor.threadId,
    authorCatId: actor.catId,
    reviewMessageId: trigger.id,
  });
  if (!provenance || provenance.recordedAt > proposal.approvedAt) return null;
  const human = await deps.messages.getById(fact.acceptedRevision);
  if (
    !currentOriginal(human, actor) ||
    human.catId !== null ||
    human.timestamp > trigger.timestamp ||
    !(await hasHumanAuthority(deps, actor, task, human))
  )
    return null;
  // Keep the strict persisted v1 shape readable by previous binaries. A reviewed
  // source revision pins the complete verified relation, not just the message body.
  // Storage fences reviewed registrations away from binaries lacking this resolver.
  return {
    sourceMessageRevision: `sha256:${createHash('sha256')
      .update(
        canonicalGrowingSourceJson({
          kind: 'recorded-task-review-v1',
          triggerRevision: sourceMessageRevision,
          humanSourceRef: `message:${human.id}`,
          humanSourceRevision: deriveGrowingSourceMessageRevision(human),
          fact,
          provenance,
          proposalApprovedAt: proposal.approvedAt,
        }),
      )
      .digest('hex')}`,
  };
}

export function sameDevelopmentReturnSource(
  state: DevelopmentReturnRegistrationV1,
  source: Awaited<ReturnType<typeof resolveDevelopmentReturnSource>>,
): boolean {
  return !!source && source.sourceMessageRevision === state.sourceMessageRevision;
}
