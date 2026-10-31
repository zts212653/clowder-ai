/**
 * Hook content resolver for prompt injection viewer (F237 Phase 2).
 *
 * Fallback path for segments NOT in TEMPLATE_FILES but registered
 * via hook.yaml in assets/prompt-hooks/. Uses HookRegistry to
 * locate the template file and read its content.
 *
 * Replaces the old manifest.yaml reader (deleted in Phase 2 sync).
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HookRegistry } from '../domains/prompt-hooks/HookRegistry.js';

function findProjectRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
}

export interface HookContentResult {
  segmentId: string;
  allowLocalOverride: false;
  hasOverride: false;
  hasBackup: false;
  content: string;
  baseContent: string;
  vars: string[];
}

// Lazy-init registry singleton (same instance as manifest route)
let registry: HookRegistry | null = null;

function getRegistry(): HookRegistry {
  if (registry) return registry;
  const root = findProjectRoot();
  registry = new HookRegistry(join(root, 'assets', 'prompt-hooks'), join(root, 'assets', 'prompt-templates'));
  registry.scan();
  return registry;
}

/**
 * Read template content for a hook-registered segment.
 * Returns null if the segment isn't in the hook registry.
 */
export async function resolveHookContent(id: string): Promise<HookContentResult | null> {
  const reg = getRegistry();
  const hook = reg.getHook(id);
  if (!hook) return null;

  const { templatePath } = hook;
  if (!existsSync(templatePath)) return null;

  const content = await readFile(templatePath, 'utf-8');
  const vars: string[] = [];
  for (const m of content.matchAll(/\{\{(\w+)\}\}/g)) {
    if (!vars.includes(m[1])) vars.push(m[1]);
  }

  return {
    segmentId: id,
    allowLocalOverride: false,
    hasOverride: false,
    hasBackup: false,
    content,
    baseContent: content,
    vars,
  };
}
