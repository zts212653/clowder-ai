import { accessSync, constants, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { findMonorepoRoot } from './monorepo-root.js';

/**
 * Resolve the runtime project root used by Hub routes and provider/profile lookups.
 * Prefer CAT_TEMPLATE_PATH when present (worktree-aware), fallback to monorepo root.
 */
export function resolveActiveProjectRoot(start = process.cwd()): string {
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
