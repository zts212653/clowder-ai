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
    /* F056 Phase E split: theme-tokens.css 拆为 4 个文件，每个独立 ≤350 行 */
    const entrypoints = [
      'globals.css',
      'theme-tokens.css',
      'cat-persona-tokens.css',
      'cat-persona-derived.css',
      'connector-tokens.css',
      'theme-extras.css',
      'console-tokens.css',
      'console-shell.css',
      'console-controls.css',
    ];

    for (const file of entrypoints) {
      expect(lineCount(resolve(appDir, file))).toBeLessThanOrEqual(350);
    }
  });

  it('loads split global css files from the root layout', () => {
    const layoutSource = readFileSync(resolve(appDir, 'layout.tsx'), 'utf8');

    /* globals.css is the only CSS still loaded via JS import */
    expect(layoutSource).toContain("import './globals.css';");

    /* All other token/control sheets are served as static <link> tags via /vendor/app/ */
    const vendorSheets = [
      'theme-tokens.css',
      'cat-persona-tokens.css',
      'cat-persona-derived.css',
      'connector-tokens.css',
      'theme-extras.css',
      'console-tokens.css',
      'console-shell.css',
      'console-controls.css',
    ];
    for (const sheet of vendorSheets) {
      expect(layoutSource).toContain(`/vendor/app/${sheet}`);
    }
  });
});
