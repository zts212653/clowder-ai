import type { CatId, CliEffortPreset } from '@cat-cafe/shared';

type ExecutionSettingsWrite =
  | { projectPath: string }
  | { hasBootcampState: boolean }
  | { catId: CatId; effort: CliEffortPreset | null };

type WriteListener = (write: ExecutionSettingsWrite) => void;
const pendingAdmissions = new Map<string, Set<WriteListener>>();

/** Observe writes handled by this API process while an admission is awaiting I/O. */
export function watchThreadExecutionSettings(
  threadId: string,
  expected: {
    catId: CatId;
    projectPath: string | undefined;
    hasBootcampState: boolean;
    effort: CliEffortPreset | undefined;
  },
) {
  let listeners = pendingAdmissions.get(threadId);
  if (!listeners) {
    listeners = new Set<WriteListener>();
    pendingAdmissions.set(threadId, listeners);
  }
  const usesThreadProject = expected.projectPath && expected.projectPath !== 'default';
  let current = true;
  const listener: WriteListener = (write) => {
    if ('projectPath' in write) current &&= write.projectPath === expected.projectPath;
    else if ('hasBootcampState' in write) {
      // With a bound project, bootcamp state does not select the working directory.
      if (!usesThreadProject) current &&= write.hasBootcampState === expected.hasBootcampState;
    } else if (write.catId === expected.catId) current &&= (write.effort ?? undefined) === expected.effort;
  };
  listeners.add(listener);
  return {
    isCurrent: () => current,
    close: () => {
      if (listeners.delete(listener) && listeners.size === 0) pendingAdmissions.delete(threadId);
    },
  };
}

export function noteThreadExecutionSettingsWrite(threadId: string, write: ExecutionSettingsWrite): void {
  const listeners = pendingAdmissions.get(threadId);
  if (listeners) for (const listener of listeners) listener(write);
}
