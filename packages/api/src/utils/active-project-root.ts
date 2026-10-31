import { accessSync, constants, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { findMonorepoRoot } from './monorepo-root.js';

/**
 * Resolve the runtime project root used by Hub routes and provider/profile lookups.
 *
 * Resolution order:
 * 1. CAT_CAFE_CONFIG_ROOT — explicit platform config root (decoupled from cwd).
 * 2. CAT_TEMPLATE_PATH   — worktree-aware template directory.
 * 3. findMonorepoRoot()  — walk up from `start` looking for pnpm-workspace.yaml.
 *
 * Results are cached by (start, env vars) composite key (#950).
 * Env-set paths that point to invalid/inaccessible locations are NOT cached
 * so that corrections (e.g. creating the directory) take effect immediately.
 */
const _activeRootCache = new Map<string, string>();

export function resolveActiveProjectRoot(start = process.cwd()): string {
  const configRoot = process.env.CAT_CAFE_CONFIG_ROOT?.trim() ?? '';
  const templatePath = process.env.CAT_TEMPLATE_PATH?.trim() ?? '';
  const cacheKey = `${resolve(start)}|${configRoot}|${templatePath}`;
  const cached = _activeRootCache.get(cacheKey);
  if (cached !== undefined) return cached;

  let result: string | undefined;

  if (configRoot) {
    const resolved = resolve(configRoot);
    try {
      if (statSync(resolved).isDirectory()) {
        result = resolved;
      }
    } catch {
      // Non-existent or inaccessible — fall through to other strategies.
    }
  }

  if (result === undefined && templatePath) {
    const resolvedTemplatePath = resolve(templatePath);
    try {
      if (statSync(resolvedTemplatePath).isFile()) {
        accessSync(resolvedTemplatePath, constants.R_OK);
        result = dirname(resolvedTemplatePath);
      }
    } catch {
      // Missing/unreadable templates should not redirect account/config lookups.
    }
  }

  if (result === undefined) {
    result = findMonorepoRoot(start);
  }

  // Only cache when the result came from a valid source — if env pointed to an
  // invalid path and we fell through, don't cache the fallback under those env
  // values (the env path might become valid later on first-run).
  const envWasInvalid =
    (configRoot && result !== resolve(configRoot)) || (templatePath && result !== dirname(resolve(templatePath)));
  if (!envWasInvalid) {
    _activeRootCache.set(cacheKey, result);
  }

  return result;
}

/** @internal — exposed only for testing. */
export function _clearActiveRootCacheForTest(): void {
  _activeRootCache.clear();
}
