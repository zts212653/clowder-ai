import { describe, expect, it } from 'vitest';
import { shouldFoldText, TEXT_FOLD_THRESHOLD } from '../textFold';

describe('shouldFoldText', () => {
  it('returns false for short text', () => {
    expect(shouldFoldText('line 1\nline 2\nline 3')).toBe(false);
  });

  it('returns false for exactly threshold lines', () => {
    const text = Array.from({ length: TEXT_FOLD_THRESHOLD }, (_, i) => `line ${i + 1}`).join('\n');
    expect(shouldFoldText(text)).toBe(false);
  });

  it('returns true for text exceeding threshold', () => {
    const text = Array.from({ length: TEXT_FOLD_THRESHOLD + 1 }, (_, i) => `line ${i + 1}`).join('\n');
    expect(shouldFoldText(text)).toBe(true);
  });

  it('returns false for empty string', () => {
    expect(shouldFoldText('')).toBe(false);
  });

  it('returns false for single line', () => {
    expect(shouldFoldText('hello world')).toBe(false);
  });

  it('returns false for exactly threshold lines with trailing newline', () => {
    const text = 'x\n'.repeat(TEXT_FOLD_THRESHOLD);
    expect(shouldFoldText(text)).toBe(false);
  });

  it('threshold defaults to 20', () => {
    expect(TEXT_FOLD_THRESHOLD).toBe(20);
  });
});
