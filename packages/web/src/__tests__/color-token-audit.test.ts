import { execSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const WEB_SRC = path.resolve(__dirname, '..');

const REDUNDANT_PATTERNS = [
  /border-cafe[\w-]* dark:border-gray-\d+/,
  /text-cafe-(?:secondary|muted) dark:text-gray-\d+/,
  /bg-cafe-surface(?:-elevated|-sunken)? dark:bg-gray-\d+/,
];

describe('color token audit', () => {
  it('no redundant dark: overrides on semantic token classes', () => {
    const output = execSync(
      `grep -rn "dark:" --include="*.tsx" --include="*.ts" "${WEB_SRC}" | grep -v node_modules | grep -v ".test."`,
      { encoding: 'utf-8', maxBuffer: 1024 * 1024 },
    ).trim();

    const violations: string[] = [];
    for (const line of output.split('\n')) {
      if (REDUNDANT_PATTERNS.some((pat) => pat.test(line))) {
        violations.push(line);
      }
    }

    expect(violations, `Found ${violations.length} redundant dark: overrides:\n${violations.join('\n')}`).toHaveLength(
      0,
    );
  });

  it('remaining dark: usages are within expected count', () => {
    const output = execSync(
      `grep -rn "dark:" --include="*.tsx" --include="*.ts" "${WEB_SRC}" | grep -v node_modules | grep -v ".test." | wc -l`,
      { encoding: 'utf-8' },
    ).trim();

    const count = parseInt(output, 10);
    expect(count).toBeLessThanOrEqual(50);
  });
});
