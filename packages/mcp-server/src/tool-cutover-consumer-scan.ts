import { access, readdir, readFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { FIXED_CUTOVER_CONSUMER_ROOTS } from './tool-cutover.js';
import {
  CUTOVER_NEGATIVE_REFERENCE_KINDS,
  CUTOVER_NEGATIVE_REFERENCE_MARKER,
  type CutoverConsumerMatch,
  type CutoverConsumerScan,
  type CutoverNegativeReference,
} from './tool-cutover-negative-references.js';

const NEGATIVE_REFERENCE_PATTERN = new RegExp(
  `(?:^|\\s)// ${CUTOVER_NEGATIVE_REFERENCE_MARKER} (${CUTOVER_NEGATIVE_REFERENCE_KINDS.join('|')})\\s*$`,
);

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function repoRelative(repoRoot: string, path: string): string {
  return relative(repoRoot, path).split(sep).join('/');
}

export async function scanRetiredNames(repoRoot: string, names: readonly string[]): Promise<CutoverConsumerScan[]> {
  return Promise.all(
    [...new Set(names)].sort().map(async (retiredName) => {
      const matches: CutoverConsumerMatch[] = [];
      const negativeReferences: CutoverNegativeReference[] = [];
      for (const root of FIXED_CUTOVER_CONSUMER_ROOTS) {
        const absoluteRoot = resolve(repoRoot, root);
        if (!(await exists(absoluteRoot))) continue;
        const entries = await readdir(absoluteRoot, { recursive: true, withFileTypes: true });
        const paths = entries
          .filter((entry) => entry.isFile())
          .map((entry) => resolve(entry.parentPath, entry.name))
          .sort();
        for (const path of paths) {
          const content = await readFile(path, 'utf8').catch(() => '');
          content.split(/\r?\n/).forEach((line, index) => {
            if (!line.includes(retiredName)) return;
            const match = { root, path: repoRelative(repoRoot, path), line: index + 1 };
            matches.push(match);
            const marker = line.match(NEGATIVE_REFERENCE_PATTERN);
            if (marker) {
              negativeReferences.push({
                ...match,
                kind: marker[1] as CutoverNegativeReference['kind'],
              });
            }
          });
        }
      }
      return {
        retiredName,
        scannedRoots: FIXED_CUTOVER_CONSUMER_ROOTS,
        matches,
        negativeReferences,
        resolvedConsumers: [],
      };
    }),
  );
}
