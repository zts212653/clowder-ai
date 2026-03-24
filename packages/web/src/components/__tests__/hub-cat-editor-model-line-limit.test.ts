import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const modelPath = resolve(testDir, '..', 'hub-cat-editor.model.ts');

describe('hub-cat-editor.model.ts', () => {
  it('stays within the 500-line intake limit (P2: refactor to 350)', () => {
    const lineCount = readFileSync(modelPath, 'utf8').split('\n').length;
    expect(lineCount).toBeLessThanOrEqual(500);
  });
});
