// F186 Phase B: dispatch CollectionManifest.scannerLevel → scanner instance

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CollectionManifest } from './collection-types.js';
import { FlatScanner } from './FlatScanner.js';
import type { RepoScanner } from './interfaces.js';
import { StructuredScanner } from './StructuredScanner.js';

export function resolveCollectionScanner(manifest: CollectionManifest): RepoScanner {
  const level = manifest.scannerLevel === 'auto' ? detectScannerLevel(manifest.root) : manifest.scannerLevel;

  if (level === 0) return new FlatScanner(manifest.id, manifest.exclude);
  return new StructuredScanner(manifest.id, manifest.exclude);
}

export function detectScannerLevel(root: string): 0 | 1 {
  if (existsSync(join(root, 'SUMMARY.md'))) return 1;

  let total = 0;
  let withFrontmatter = 0;
  try {
    for (const entry of readdirSync(root)) {
      if (!entry.endsWith('.md')) continue;
      if (total >= 20) break;
      total++;
      try {
        const head = readFileSync(join(root, entry), 'utf-8').slice(0, 512);
        if (/^---\n/.test(head)) withFrontmatter++;
      } catch {
        /* skip unreadable */
      }
    }
  } catch {
    return 0;
  }

  return total > 0 && withFrontmatter / total >= 0.5 ? 1 : 0;
}
