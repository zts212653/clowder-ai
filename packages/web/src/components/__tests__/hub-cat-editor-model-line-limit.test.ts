import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const modelPath = resolve(testDir, '..', 'hub-cat-editor.model.ts');

describe('hub-cat-editor.model.ts', () => {
  it('stays within the 350-line hard limit', () => {
    const lineCount = readFileSync(modelPath, 'utf8').split('\n').length;
    expect(lineCount).toBeLessThanOrEqual(350);
  });
});
