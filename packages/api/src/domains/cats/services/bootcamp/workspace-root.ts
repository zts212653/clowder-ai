import { resolve } from 'node:path';
import { validateProjectPath } from '../../../../utils/project-path.js';

export type BootcampWorkspaceRootResolution = { ok: true; projectPath: string } | { ok: false; error: string };

export function resolveDefaultBootcampWorkspaceRoot(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string | null {
  const workspaceRoot = env.CAT_CAFE_WORKSPACE_ROOT?.trim();
  if (workspaceRoot) return workspaceRoot;

  // Runtime worktree mode must export CAT_CAFE_WORKSPACE_ROOT. Falling back to
  // process.cwd() here would bind bootcamp development to cat-cafe-runtime.
  if (env.CAT_CAFE_RUNTIME_ROOT?.trim()) {
    return null;
  }

  return cwd;
}

export async function resolveBootcampWorkspaceRoot(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): Promise<BootcampWorkspaceRootResolution> {
  const bootcampWorkspaceRoot = resolveDefaultBootcampWorkspaceRoot(env, cwd);
  if (!bootcampWorkspaceRoot) {
    return {
      ok: false,
      error: 'Bootcamp workspace root is not configured; refusing to use runtime cwd',
    };
  }

  const validated = await validateProjectPath(bootcampWorkspaceRoot);
  if (!validated) {
    return {
      ok: false,
      error: `Bootcamp workspace root is invalid: ${resolve(bootcampWorkspaceRoot)}`,
    };
  }

  return { ok: true, projectPath: validated };
}
