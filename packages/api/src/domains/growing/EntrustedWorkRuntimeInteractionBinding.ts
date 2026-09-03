import type { CatId, EntrustedWorkTaskRefV1, TaskItem } from '@cat-cafe/shared';
import { entrustedWorkTaskRefV1Schema } from '@cat-cafe/shared';

export interface EntrustedWorkSourceBinding {
  readonly sourceMessageId: string;
  readonly threadId: string;
  readonly ownerUserId: string;
  readonly ownerCatId: CatId;
}

/**
 * Resolve an F306 relationship from Task-owned source provenance.
 * Zero or multiple matches stay unlinked so neither invocation proximity nor
 * presentation context can guess which Task a producer belongs to.
 */
export function resolveEntrustedWorkTaskRefFromSource(
  tasks: readonly TaskItem[],
  binding: EntrustedWorkSourceBinding,
): EntrustedWorkTaskRefV1 | undefined {
  const sourceRef = `message:${binding.sourceMessageId}`;
  const matches = tasks.filter((task) => {
    const contract = task.entrustedWork;
    return (
      task.kind === 'work' &&
      task.threadId === binding.threadId &&
      task.userId === binding.ownerUserId &&
      task.ownerCatId === binding.ownerCatId &&
      task.status !== 'done' &&
      contract?.closure.state === 'open' &&
      contract.admission.sourceRefs.includes(sourceRef)
    );
  });
  if (matches.length !== 1) return undefined;
  const match = matches[0];
  if (!match?.entrustedWork) return undefined;
  return entrustedWorkTaskRefV1Schema.parse({
    subjectRef: `task:work:${match.id}`,
    observedRevision: match.entrustedWork.revision,
  });
}
