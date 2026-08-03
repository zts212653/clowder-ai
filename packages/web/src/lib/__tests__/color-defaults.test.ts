import { describe, expect, it } from 'vitest';
import { CAT_COLORS, UNKNOWN_CAT_COLOR } from '../color-defaults';

describe('color-defaults CAT_COLORS', () => {
  it('has codex-sol maine-coon green fallback (F203 Case C)', () => {
    // F203 Case C: codex-sol must have explicit fallback so pre-catalog/SSR
    // renders maine-coon family green, not UNKNOWN_CAT_COLOR purple.
    // See PR #3329 + F278 exact-source owner review 4829735601.
    const solColor = CAT_COLORS['codex-sol'];
    expect(solColor).toBeDefined();
    expect(solColor).not.toEqual(UNKNOWN_CAT_COLOR);

    // Must inherit maine-coon family green (matches codex)
    const codexColor = CAT_COLORS.codex;
    expect(solColor).toEqual(codexColor);
    expect(solColor.primary).toBe('#5B8C5A');
    expect(solColor.secondary).toBe('#D4E6D3');
  });

  it('all family-color entries have both primary and secondary', () => {
    for (const [catId, color] of Object.entries(CAT_COLORS)) {
      expect(color.primary, `${catId}.primary`).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(color.secondary, `${catId}.secondary`).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });
});
