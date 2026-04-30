// @vitest-environment node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(testDir, '..', '..', '..');
const appDir = resolve(webRoot, 'src', 'app');

function lineCount(filePath: string): number {
  return readFileSync(filePath, 'utf8').split('\n').length;
}

describe('global css architecture', () => {
  it('keeps each global css entrypoint under the 350-line hard limit', () => {
    const entrypoints = ['globals.css', 'theme-tokens.css', 'console-shell.css', 'console-controls.css'];

    for (const file of entrypoints) {
      expect(lineCount(resolve(appDir, file))).toBeLessThanOrEqual(350);
    }
  });

  it('loads split global css files from the root layout', () => {
    const layoutSource = readFileSync(resolve(appDir, 'layout.tsx'), 'utf8');

    expect(layoutSource).toContain("import './theme-tokens.css';");
    expect(layoutSource).toContain("import './globals.css';");
    expect(layoutSource).toContain("import './console-shell.css';");
    expect(layoutSource).toContain("import './console-controls.css';");
  });
});
