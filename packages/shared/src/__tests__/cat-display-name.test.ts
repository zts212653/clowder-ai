import { describe, expect, it } from 'vitest';
import { formatCatDisplayName } from '../cat-display-name.js';

describe('formatCatDisplayName', () => {
  it('trims the configured identity and uses full-width punctuation', () => {
    expect(formatCatDisplayName({ displayName: ' 缅因猫 ', variantLabel: ' sol ' })).toBe('缅因猫（sol）');
  });

  it('does not repeat a variant already present in the display name', () => {
    expect(formatCatDisplayName({ displayName: '布偶猫 Fable', variantLabel: 'fable' })).toBe('布偶猫 Fable');
  });

  it('omits an empty variant label', () => {
    expect(formatCatDisplayName({ displayName: ' 布偶猫 ', variantLabel: ' ' })).toBe('布偶猫');
  });
});
