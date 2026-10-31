import { realpath } from 'node:fs/promises';
import { findMonorepoRoot } from '../../../../../utils/monorepo-root.js';
import { resolvePersistentProjectPathDetailed } from '../../../../../utils/persistent-project-path.js';
import { isPathUnderRoots } from '../../../../../utils/project-path.js';
import { DEFAULT_THREAD_ID, type Thread } from '../../stores/ports/ThreadStore.js';

type WorkspaceThread = Pick<Thread, 'id' | 'createdBy' | 'projectPath' | 'systemKind' | 'deletedAt' | 'bootcampState'>;

/** Only the admitted ordinary conversation may use the platform's default workspace. */
export function canUseDefaultThreadWorkspace(thread: WorkspaceThread, threadId: string, userId: string): boolean {
  if (thread.id !== threadId || thread.deletedAt || thread.systemKind || thread.bootcampState) return false;
  if (thread.projectPath && thread.projectPath !== 'default') return false;
  return thread.createdBy === userId || (threadId === DEFAULT_THREAD_ID && thread.createdBy === 'system');
}

/** Match the existing default project UI, while never inheriting a disposable runtime cwd. */
export async function resolveDefaultThreadWorkspace(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const configured = env.CAT_CAFE_WORKSPACE_ROOT?.trim();
  const runtime = env.CAT_CAFE_RUNTIME_ROOT?.trim();
  if (runtime && !configured) {
    return { ok: false, error: 'Default workspace is not configured; refusing to use the runtime working directory.' };
  }
  const workspace = await resolvePersistentProjectPathDetailed(configured || findMonorepoRoot(cwd), {
    runtimeRoot: runtime ?? '',
    workspaceRoot: configured ?? '',
  });
  if (!workspace.ok) {
    return {
      ok: false,
      error: `Default workspace is unavailable (${workspace.reason}). Check the configured workspace.`,
    };
  }
  if (runtime) {
    try {
      if (isPathUnderRoots(workspace.path, [await realpath(runtime)])) {
        return { ok: false, error: 'Default workspace must be outside the disposable runtime directory.' };
      }
    } catch {
      return { ok: false, error: 'Unable to validate the runtime boundary for the default workspace.' };
    }
  }
  return { ok: true, path: workspace.path };
}
