/** Account roots only: no general data-root migration, copy or cutover. */
import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { findMonorepoRoot } from '../utils/monorepo-root.js';
import { isPathUnderRoots, pathsEqual } from '../utils/project-path.js';
import { AccountStoreVerdictError } from './account-store-format.js';

export interface AccountStoreTopology {
  primaryRoot: string;
  legacyRoot?: string;
}

function directory(path: string): string {
  try {
    const canonical = realpathSync(path);
    if (statSync(canonical).isDirectory()) return canonical;
  } catch {
    // Only the configuration path is included; no account or credential payload.
  }
  throw new AccountStoreVerdictError(`accounts root unresolvable: invalid directory ${path}`);
}

export function resolveAccountStoreTopology(projectRoot?: string): AccountStoreTopology {
  const override = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT?.trim();
  if (override) return { primaryRoot: resolve(override) };
  const requested = resolve(projectRoot ?? homedir());
  const runtime = process.env.CAT_CAFE_RUNTIME_ROOT?.trim();
  if (!runtime) return { primaryRoot: requested };
  const runtimeRoot = directory(runtime);
  const target = directory(requested);
  const workspace = process.env.CAT_CAFE_WORKSPACE_ROOT?.trim();
  if (!isPathUnderRoots(target, [runtimeRoot])) {
    // External projects retain their own stores; a workspace API cwd shares its workspace root.
    if (!workspace) return { primaryRoot: requested };
    const workspaceRoot = directory(workspace);
    if (!pathsEqual(findMonorepoRoot(target), workspaceRoot)) return { primaryRoot: requested };
    return pathsEqual(workspaceRoot, runtimeRoot)
      ? { primaryRoot: workspaceRoot }
      : { primaryRoot: workspaceRoot, legacyRoot: runtimeRoot };
  }
  if (!workspace) throw new AccountStoreVerdictError('accounts root unresolvable: CAT_CAFE_WORKSPACE_ROOT is required');
  const primaryRoot = directory(workspace);
  return pathsEqual(primaryRoot, runtimeRoot) ? { primaryRoot } : { primaryRoot, legacyRoot: runtimeRoot };
}

export function resolveAccountWriteRoot(projectRoot?: string): string {
  return resolveAccountStoreTopology(projectRoot).primaryRoot;
}
