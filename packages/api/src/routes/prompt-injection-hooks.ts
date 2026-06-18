/**
 * Hook script content resolver for prompt injection viewer (F237).
 * Reads .claude/hooks/ shell scripts for H-prefixed segments.
 * Extracted from prompt-injection.ts to respect the 350-line limit.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

function findProjectRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
}

interface ManifestEntry {
  id: string;
  source?: string;
  sourceType?: string;
  [k: string]: unknown;
}

let manifestCache: ManifestEntry[] | null = null;

function loadManifestEntries(): ManifestEntry[] {
  if (manifestCache) return manifestCache;
  const root = findProjectRoot();
  const p = join(root, 'assets', 'prompt-injection-manifest.yaml');
  if (!existsSync(p)) return [];
  const parsed = YAML.parse(readFileSync(p, 'utf-8')) as { segments?: ManifestEntry[] };
  manifestCache = Array.isArray(parsed.segments) ? parsed.segments : [];
  return manifestCache;
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

/** Read hook script file for H-prefixed segments. Returns null if not a hook. */
export async function resolveHookContent(id: string): Promise<HookContentResult | null> {
  const entry = loadManifestEntries().find((e) => e.id === id);
  if (!entry || entry.sourceType !== 'hook' || !entry.source) return null;
  const root = findProjectRoot();
  const scriptPath = join(root, entry.source);
  if (!existsSync(scriptPath) || !statSync(scriptPath).isFile()) return null;
  const content = await readFile(scriptPath, 'utf-8');
  return {
    segmentId: id,
    allowLocalOverride: false,
    hasOverride: false,
    hasBackup: false,
    content,
    baseContent: content,
    vars: [],
  };
}
