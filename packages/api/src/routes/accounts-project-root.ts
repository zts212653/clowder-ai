import { realpath, stat } from 'node:fs/promises';
import { relative, resolve, win32 } from 'node:path';
import { resolveActiveProjectRoot } from '../utils/active-project-root.js';
import { findMonorepoRoot } from '../utils/monorepo-root.js';
import { redirectRuntimeProjectPath, resolvePersistentProjectPathDetailed } from '../utils/persistent-project-path.js';

const MONOREPO_ROOT = findMonorepoRoot();
export async function resolveAccountProjectRoot(projectPath?: string): Promise<string | null> {
  if (!projectPath) return redirectRuntimeProjectPath(resolveActiveProjectRoot());
  const persistent = await resolvePersistentProjectPathDetailed(projectPath);
  if (persistent.ok) return persistent.path;
  if (['runtime_root_invalid', 'runtime_workspace_missing', 'runtime_target_unmappable'].includes(persistent.reason)) {
    return null;
  }

  // Workspace project switcher can provide sibling repo paths (outside homedir/tmp allowlist).
  // Allow paths under current workspace root while keeping realpath boundary checks.
  const workspaceRoot = resolve(MONOREPO_ROOT, '..');
  try {
    const [resolvedTarget, resolvedWorkspaceRoot] = await Promise.all([
      realpath(resolve(projectPath)),
      realpath(workspaceRoot),
    ]);
    const rel = relative(resolvedWorkspaceRoot, resolvedTarget);
    if (win32.isAbsolute(rel) || rel.startsWith('..') || rel.startsWith('/') || rel.startsWith('\\')) return null;
    const info = await stat(resolvedTarget);
    return info.isDirectory() ? resolvedTarget : null;
  } catch {
    return null;
  }
}
