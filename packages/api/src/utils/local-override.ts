/**
 * .local / .local-override file resolution (#603)
 *
 * Convention:
 *   foo.local.md        → merge (append after base content)
 *   foo.local-override.md → override (replace base content entirely)
 *
 * Override takes precedence: if both exist, only override is used.
 */

import { readFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';

export interface LocalOverlayResult {
  content: string;
  source: 'override' | 'local' | 'base';
  path: string;
}

function localPaths(basePath: string) {
  const dir = dirname(basePath);
  const ext = extname(basePath);
  const stem = basename(basePath, ext);
  return {
    override: join(dir, `${stem}.local-override${ext}`),
    local: join(dir, `${stem}.local${ext}`),
  };
}

async function tryRead(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Resolve a file with .local-override / .local overlay support.
 *
 * @param basePath - absolute path to the base file (e.g. shared-rules.md)
 * @param baseContent - content to use as base (if already loaded or hardcoded)
 *                      If omitted, reads from basePath.
 * @returns resolved content + metadata
 */
export async function resolveWithLocalOverlay(basePath: string, baseContent?: string): Promise<LocalOverlayResult> {
  const paths = localPaths(basePath);

  const overrideContent = await tryRead(paths.override);
  if (overrideContent !== null) {
    return { content: overrideContent, source: 'override', path: paths.override };
  }

  const localContent = await tryRead(paths.local);
  const base = baseContent ?? (await tryRead(basePath)) ?? '';

  if (localContent !== null) {
    return {
      content: `${base}\n\n${localContent}`,
      source: 'local',
      path: paths.local,
    };
  }

  return { content: base, source: 'base', path: basePath };
}
