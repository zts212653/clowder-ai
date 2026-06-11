// @vitest-environment node
/**
 * #862 regression: env-var KEY/VALUE inputs in UnifiedAuthModal must be wrapped
 * in separate div containers with flex-constraining classes so that formInputClass's
 * w-full doesn't collapse the flex layout into a single column.
 *
 * KEY wrapper → `w-[38%] shrink-0`  (fixed proportion)
 * VALUE wrapper → `min-w-0 flex-1`  (fills remaining space)
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(__dirname, '../UnifiedAuthModal.tsx'), 'utf-8');

describe('UnifiedAuthModal env-var layout (#862)', () => {
  it('KEY input is wrapped in a w-[38%] shrink-0 container', () => {
    expect(source).toContain('w-[38%] shrink-0');
    const wrapperIdx = source.indexOf('w-[38%] shrink-0');
    const keyInputIdx = source.indexOf('placeholder="KEY"');
    expect(keyInputIdx).toBeGreaterThan(wrapperIdx);
    expect(keyInputIdx - wrapperIdx).toBeLessThan(500);
  });

  it('VALUE input is wrapped in a min-w-0 flex-1 container', () => {
    expect(source).toContain('min-w-0 flex-1');
    const wrapperIdx = source.indexOf('min-w-0 flex-1');
    const valueInputIdx = source.indexOf('placeholder="value"');
    expect(valueInputIdx).toBeGreaterThan(wrapperIdx);
    expect(valueInputIdx - wrapperIdx).toBeLessThan(500);
  });

  it('formInputClass contains w-full (the root cause that requires wrappers)', () => {
    const helperSource = readFileSync(resolve(__dirname, '../mcp-form-helpers.tsx'), 'utf-8');
    expect(helperSource).toMatch(/formInputClass[\s\S]*?w-full/);
  });
});
