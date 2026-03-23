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
 */
export function resolveActiveProjectRoot(start = process.cwd()): string {
  const configRoot = process.env.CAT_CAFE_CONFIG_ROOT?.trim();
  if (configRoot) {
    const resolved = resolve(configRoot);
    try {
      if (statSync(resolved).isDirectory()) {
        return resolved;
      }
    } catch {
      // Non-existent or inaccessible — fall through to other strategies.
    }
  }

  const templatePath = process.env.CAT_TEMPLATE_PATH?.trim();
  if (templatePath) {
    const resolvedTemplatePath = resolve(templatePath);
    try {
      if (statSync(resolvedTemplatePath).isFile()) {
        accessSync(resolvedTemplatePath, constants.R_OK);
        return dirname(resolvedTemplatePath);
      }
    } catch {
      // Missing/unreadable templates should not redirect account/config lookups.
    }
  }
  return findMonorepoRoot(start);
}
