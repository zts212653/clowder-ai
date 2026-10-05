// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MEMORY_BOOK_STAR_PATH } from '../memory-book-star-path';

const SRC_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const DEFINITION = join('components', 'shell', 'memory-book-star-path.ts');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(full);
    return /\.(tsx?|jsx?|mjs|css|svg)$/.test(entry.name) ? [full] : [];
  });
}

describe('F322 记忆 icon single definition', () => {
  it('keeps the traced outline in exactly one source file', () => {
    // The sidebar 记忆 entry and the Workspace 记忆 tile share D; a second copy would let them drift apart again.
    const fingerprint = MEMORY_BOOK_STAR_PATH.slice(0, 48);
    const holders = sourceFiles(SRC_ROOT)
      .filter((file) => readFileSync(file, 'utf8').includes(fingerprint))
      .map((file) => relative(SRC_ROOT, file));
    expect(holders).toEqual([DEFINITION]);
  });
});
