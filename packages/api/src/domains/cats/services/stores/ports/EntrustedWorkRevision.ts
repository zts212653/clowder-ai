import type { EntrustedWorkV1, TaskItem } from '@cat-cafe/shared';

function nextRevision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value === Number.MAX_SAFE_INTEGER) {
    throw new Error('Entrusted Task revision cannot advance');
  }
  return value + 1;
}

/** Ordinary owner mutations revoke execution. Legacy contracts remain explicitly unversioned. */
export function advanceEntrustedWorkRevision(
  current: EntrustedWorkV1,
): Pick<EntrustedWorkV1, 'revision' | 'executionAuthorityRevision'> {
  return {
    revision: nextRevision(current.revision),
    ...(current.executionAuthorityRevision === undefined
      ? {}
      : { executionAuthorityRevision: nextRevision(current.executionAuthorityRevision) }),
  };
}

/** Task metadata/wait changes are authority changes too; both storage implementations use this kernel. */
export function advanceEntrustedTaskAuthority(previous: TaskItem, next: TaskItem): TaskItem {
  if (!previous.entrustedWork) return next;
  if (!next.entrustedWork) throw new Error('Entrusted Task contract cannot be removed');
  return {
    ...next,
    entrustedWork: { ...next.entrustedWork, ...advanceEntrustedWorkRevision(previous.entrustedWork) },
  };
}
