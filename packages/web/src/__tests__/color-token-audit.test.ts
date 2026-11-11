import { execSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const WEB_SRC = path.resolve(__dirname, '..');

const REDUNDANT_PATTERNS = [
  /border-cafe[\w-]* dark:border-gray-\d+/,
  /text-cafe-(?:secondary|muted) dark:text-gray-\d+/,
  /bg-cafe-surface(?:-elevated|-sunken)? dark:bg-gray-\d+/,
];

function hasDarkUtility(line: string): boolean {
  return /(?:^|[\s"'`])(?!--)(?:[^\s"'`]+:)*dark:[^\s"'`]+/.test(line);
}

describe('color token audit', () => {
  it.each([
    ['className="dark:bg-red-500"', true],
    ['className="sm:dark:bg-red-500"', true],
    ['className="hover:dark:text-red-500"', true],
    ['className="[&>button]:dark:hover:bg-red-500"', true],
    ['dark: image.opacity.dark', false],
    ['`--color-cat-dark:var(--color-text);`', false],
  ])('recognizes dark utility lines: %s', (line, expected) => {
    expect(hasDarkUtility(line)).toBe(expected);
  });

  it('no redundant dark: overrides on semantic token classes', () => {
    const output = execSync(
      `grep -rn "dark:" --include="*.tsx" --include="*.ts" "${WEB_SRC}" | grep -v node_modules | grep -v "\\.test\\." || true`,
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

  it('remaining dark: utility lines are within the existing budget', () => {
    const output = execSync(
      `grep -rn "dark:" --include="*.tsx" --include="*.ts" "${WEB_SRC}" | grep -v node_modules | grep -v "\\.test\\." || true`,
      { encoding: 'utf-8' },
    ).trim();

    // Typed data fields such as `dark: image.opacity.dark` and CSS custom-property
    // names are not Tailwind utilities and consume none of this unchanged budget.
    const count = output.split('\n').filter(hasDarkUtility).length;
    expect(count).toBeLessThanOrEqual(50);
  });
});
