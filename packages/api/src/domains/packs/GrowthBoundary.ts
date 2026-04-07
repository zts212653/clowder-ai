/**
 * F129 GrowthBoundary — Ensures exported packs contain no private Growth data.
 * KD-11: Pack = shareable cultural seed; Growth = local private relationship fruit.
 * Growth data must never appear in exported or installed packs.
 */

import { readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

export interface GrowthCheckResult {
  clean: boolean;
  violations: string[];
}

/** File extensions that always indicate Growth/private data */
const GROWTH_EXTENSIONS: RegExp[] = [/\.sqlite$/i, /\.db$/i, /\.env$/i, /\.env\./i];

/**
 * Exact directory names that indicate Growth data containers.
 * Only matches the directory entry name itself — not substrings of filenames.
 */
const GROWTH_DIR_NAMES = new Set(['sessions', 'threads', 'preferences', 'evidence', 'memory', 'digest', 'growth']);

/** Exact file names (stem) that indicate credentials — matches start of entry */
const GROWTH_FILE_STEMS: RegExp[] = [/^credentials/i, /^secrets/i];

/** Pack content directories — subdirectories inside these are exempt from Growth dir name checks */
const PACK_SAFE_PARENTS = new Set(['knowledge', 'masks', 'workflows', 'expression', 'bridges', 'assets']);

/**
 * Recursively scan a pack directory for Growth data violations.
 * Returns { clean: true } if no violations found.
 */
export async function checkGrowthBoundary(packDir: string): Promise<GrowthCheckResult> {
  const violations: string[] = [];
  await scanDir(packDir, packDir, violations, false);
  return { clean: violations.length === 0, violations };
}

async function scanDir(
  rootDir: string,
  currentDir: string,
  violations: string[],
  insideSafeParent: boolean,
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(currentDir);
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = join(currentDir, entry);
    const relPath = relative(rootDir, fullPath);

    let isDir = false;
    try {
      isDir = (await stat(fullPath)).isDirectory();
    } catch {
      continue; // Skip unreadable entries
    }

    let violated = false;

    if (isDir) {
      // Directories: flag if name matches Growth container, UNLESS inside a pack-safe parent
      if (!insideSafeParent && GROWTH_DIR_NAMES.has(entry.toLowerCase())) {
        violations.push(relPath);
        violated = true;
      }
    } else {
      // Files: flag by extension or exact credential stem
      if (GROWTH_EXTENSIONS.some((p) => p.test(entry))) {
        violations.push(relPath);
        violated = true;
      } else if (GROWTH_FILE_STEMS.some((p) => p.test(entry))) {
        violations.push(relPath);
        violated = true;
      }
    }

    // Recurse into subdirectories (even if the dir itself was flagged)
    if (isDir && !violated) {
      const childSafe = insideSafeParent || PACK_SAFE_PARENTS.has(entry.toLowerCase());
      await scanDir(rootDir, fullPath, violations, childSafe);
    }
  }
}
