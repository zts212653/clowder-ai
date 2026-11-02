import { providerRequiresThreadWorkspace } from '../../../../../config/account-resolver.js';
import { findMonorepoRoot } from '../../../../../utils/monorepo-root.js';
import { resolvePersistentProjectPathDetailed } from '../../../../../utils/persistent-project-path.js';
import { resolveBootcampWorkspaceRoot } from '../../bootcamp/workspace-root.js';
import type { IThreadStore, Thread } from '../../stores/ports/ThreadStore.js';
import { canUseDefaultThreadWorkspace, resolveDefaultThreadWorkspace } from './default-thread-workspace.js';
import { preflightRace } from './invoke-helpers.js';

export interface FrozenExecutionWorkspace {
  readonly thread?: Thread | null;
  readonly workingDirectory?: string;
  readonly workingProjectRoot?: string;
  readonly threadProjectPath?: string;
  readonly usesDefaultWorkspace: boolean;
}

/** Resolve the cwd before account launch identity and child admission, then pin it for this attempt. */
export async function freezeExecutionWorkspace(input: {
  threadStore: IThreadStore | null;
  threadId: string;
  userId: string;
  provider?: string;
  requiresAgyWorkspace?: boolean;
  signal?: AbortSignal;
}): Promise<FrozenExecutionWorkspace> {
  const required =
    providerRequiresThreadWorkspace(input.provider as Parameters<typeof providerRequiresThreadWorkspace>[0]) ||
    input.requiresAgyWorkspace;
  const requiredBy = input.requiresAgyWorkspace ? 'AGY' : 'OpenCode';
  let thread: Thread | null | undefined;
  let failure: string | undefined;
  try {
    thread = await preflightRace(
      Promise.resolve(input.threadStore?.get(input.threadId)),
      'threadStore.get:execution-binding',
      input.signal,
    );
  } catch {
    failure = `Unable to resolve thread workspace for ${input.threadId}. Retry this invocation.`;
  }
  let workingDirectory: string | undefined;
  let usesDefaultWorkspace = false;
  if (thread?.projectPath && thread.projectPath !== 'default') {
    if (thread.projectPath.startsWith('games/'))
      failure = `${requiredBy} requires a filesystem thread projectPath for ${input.threadId}; virtual game projectPath ${thread.projectPath} cannot be used as a working directory.`;
    else {
      const validated = await resolvePersistentProjectPathDetailed(thread.projectPath);
      if (validated.ok) {
        workingDirectory = validated.path;
        if (validated.remappedFrom && input.threadStore?.updateProjectPath) {
          try {
            await preflightRace(
              Promise.resolve(input.threadStore.updateProjectPath(input.threadId, validated.path)),
              'updateProjectPath:execution-binding',
              input.signal,
            );
          } catch {
            /* A metadata retry cannot invalidate the proven cwd for this attempt. */
          }
        }
      } else {
        const transient = ['io_error', 'runtime_root_invalid', 'runtime_workspace_missing'].includes(validated.reason);
        failure = transient
          ? `Unable to validate thread projectPath for ${input.threadId}: ${thread.projectPath}. ${validated.message ?? 'Transient filesystem error.'} Retry; if it persists, re-bind the thread's project workspace.`
          : `Invalid thread projectPath for ${input.threadId}: ${thread.projectPath}. Expected an existing directory under allowed roots.`;
      }
    }
  } else if (thread?.bootcampState) {
    const workspace = await resolveBootcampWorkspaceRoot();
    if (!workspace.ok) throw new Error(workspace.error);
    workingDirectory = workspace.projectPath;
  } else if (
    thread &&
    input.provider === 'opencode' &&
    canUseDefaultThreadWorkspace(thread, input.threadId, input.userId)
  ) {
    const workspace = await resolveDefaultThreadWorkspace();
    if (workspace.ok) {
      workingDirectory = workspace.path;
      usesDefaultWorkspace = true;
    } else failure = workspace.error;
  }
  if (required && input.threadStore && !workingDirectory)
    throw new Error(
      failure ??
        `${requiredBy} requires a thread projectPath for ${input.threadId}. Bind the thread to a project workspace before spawning ${requiredBy}.`,
    );
  return Object.freeze({
    thread,
    ...(workingDirectory ? { workingDirectory, workingProjectRoot: findMonorepoRoot(workingDirectory) } : {}),
    ...(thread?.projectPath ? { threadProjectPath: thread.projectPath } : {}),
    usesDefaultWorkspace,
  });
}
