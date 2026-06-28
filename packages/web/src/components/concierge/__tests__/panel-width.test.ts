/**
 * F229 BUG-UX-3 R4: Panel width clamping / initialization pure function tests.
 *
 * Focused regression coverage for the narrow-viewport persistence case
 * that escaped three review rounds: save a width below PANEL_MIN_W on a
 * narrow screen, reload, and keep that saved width through initialization.
 *
 * Pure functions — no React mount needed.
 */

import { describe, expect, it } from 'vitest';
import {
  clampPanelHeight,
  clampPanelWidth,
  PANEL_DEFAULT_H,
  PANEL_DEFAULT_W,
  PANEL_MAX_H,
  PANEL_MAX_W,
  PANEL_MIN_H,
  PANEL_MIN_W,
  resolveInitialPanelHeight,
  resolveInitialPanelWidth,
} from '../usePanelWidth';

// ---------------------------------------------------------------------------
// clampPanelWidth
// ---------------------------------------------------------------------------

describe('clampPanelWidth', () => {
  it('clamps below PANEL_MIN_W up to PANEL_MIN_W on wide viewport', () => {
    expect(clampPanelWidth(200, 1920)).toBe(PANEL_MIN_W); // 280
  });

  it('passes through a value within [MIN, MAX] on wide viewport', () => {
    expect(clampPanelWidth(400, 1920)).toBe(400);
  });

  it('clamps above PANEL_MAX_W down to PANEL_MAX_W', () => {
    expect(clampPanelWidth(800, 1920)).toBe(PANEL_MAX_W); // 560
  });

  it('viewport constraint wins over PANEL_MIN_W on narrow viewport', () => {
    // viewport 320 → maxViewportW = 272 → effectiveMin = 272 (< 280)
    expect(clampPanelWidth(400, 320)).toBe(272);
  });

  it('returns effectiveMin when requested width is below narrow viewport max', () => {
    // viewport 320 → maxViewportW = 272 → effectiveMin = 272
    // requested 100 < 272 → clamped up to 272
    expect(clampPanelWidth(100, 320)).toBe(272);
  });

  it('handles exact PANEL_MIN_W viewport boundary', () => {
    // viewport = PANEL_MIN_W + 48 = 328 → maxViewportW = 280 = PANEL_MIN_W
    expect(clampPanelWidth(280, 328)).toBe(280);
  });

  it('handles very small viewport gracefully', () => {
    // viewport 100 → maxViewportW = 52 → effectiveMin = 52
    expect(clampPanelWidth(300, 100)).toBe(52);
  });
});

// ---------------------------------------------------------------------------
// resolveInitialPanelWidth
// ---------------------------------------------------------------------------

describe('resolveInitialPanelWidth', () => {
  it('returns saved value when within bounds on wide viewport', () => {
    expect(resolveInitialPanelWidth('400', 1920)).toBe(400);
  });

  it('returns default when no saved value on wide viewport', () => {
    expect(resolveInitialPanelWidth(null, 1920)).toBe(PANEL_DEFAULT_W); // 384
  });

  it('clamps saved value above MAX down to MAX', () => {
    expect(resolveInitialPanelWidth('800', 1920)).toBe(PANEL_MAX_W); // 560
  });

  it('clamps saved value below MIN up to MIN on wide viewport', () => {
    expect(resolveInitialPanelWidth('100', 1920)).toBe(PANEL_MIN_W); // 280
  });

  // KEY REGRESSION: narrow-viewport persistence (R3 finding)
  it('preserves saved width below PANEL_MIN_W on narrow viewport', () => {
    // User on 300px viewport saved 252. On reload (still 300px viewport):
    // maxViewportW = 252, effectiveMin = min(280, 252) = 252
    // saved 252 is valid (finite + positive) → clamp(252, 252) = 252
    expect(resolveInitialPanelWidth('252', 300)).toBe(252);
  });

  it('re-clamps narrow-viewport save to MIN when loaded on wide viewport', () => {
    // User saved 252 on narrow screen, now on 1920px screen:
    // effectiveMin = 280 → saved 252 < 280 → clamped up to 280
    expect(resolveInitialPanelWidth('252', 1920)).toBe(PANEL_MIN_W); // 280
  });

  it('returns clamped default on narrow viewport with no saved value', () => {
    // viewport 300 → maxViewportW = 252 → effectiveMin = 252
    // default 384 → clamped to max(252, min(384, 252)) = 252
    expect(resolveInitialPanelWidth(null, 300)).toBe(252);
  });

  it('handles invalid saved value (NaN) by falling back to default', () => {
    expect(resolveInitialPanelWidth('abc', 1920)).toBe(PANEL_DEFAULT_W); // 384
  });

  it('handles invalid saved value (empty string) by falling back to default', () => {
    expect(resolveInitialPanelWidth('', 1920)).toBe(PANEL_DEFAULT_W); // 384
  });

  it('handles invalid saved value (negative) by falling back to default', () => {
    expect(resolveInitialPanelWidth('-100', 1920)).toBe(PANEL_DEFAULT_W); // 384
  });

  it('handles invalid saved value (zero) by falling back to default', () => {
    expect(resolveInitialPanelWidth('0', 1920)).toBe(PANEL_DEFAULT_W); // 384
  });

  it('handles invalid saved value (Infinity) by falling back to default', () => {
    expect(resolveInitialPanelWidth('Infinity', 1920)).toBe(PANEL_DEFAULT_W); // 384
  });
});

// ---------------------------------------------------------------------------
// clampPanelHeight
// ---------------------------------------------------------------------------

describe('clampPanelHeight', () => {
  // R1 P1 regression: PANEL_MIN_H must exceed the real layout minimum (~238px)
  // so users cannot drag to a height where content clips. Header (~45px) +
  // message area (min-h-[120px]) + input (~73px) = ~238px minimum.
  it('PANEL_MIN_H exceeds layout minimum to prevent content clipping', () => {
    const LAYOUT_MINIMUM = 238; // header + message min-h + input
    expect(PANEL_MIN_H).toBeGreaterThan(LAYOUT_MINIMUM);
  });

  it('clamps below PANEL_MIN_H up to PANEL_MIN_H on tall viewport', () => {
    expect(clampPanelHeight(100, 1080)).toBe(PANEL_MIN_H);
  });

  it('passes through a value within [MIN, MAX] on tall viewport', () => {
    expect(clampPanelHeight(400, 1080)).toBe(400);
  });

  it('clamps above PANEL_MAX_H down to PANEL_MAX_H', () => {
    expect(clampPanelHeight(900, 1080)).toBe(PANEL_MAX_H); // 700
  });

  it('viewport constraint wins over PANEL_MIN_H on short viewport', () => {
    // viewport 300 → maxViewportH = 300 - 136 = 164 → effectiveMin = 164 (< 200)
    expect(clampPanelHeight(400, 300)).toBe(164);
  });

  it('returns effectiveMin when requested height is below short viewport max', () => {
    // viewport 300 → maxViewportH = 164 → effectiveMin = 164
    // requested 50 < 164 → clamped up to 164
    expect(clampPanelHeight(50, 300)).toBe(164);
  });

  it('handles exact PANEL_MIN_H viewport boundary', () => {
    // viewport = PANEL_MIN_H + PANEL_MARGIN_V = 280 + 136 = 416 → maxViewportH = 280
    expect(clampPanelHeight(280, 416)).toBe(280);
  });

  it('handles very small viewport gracefully', () => {
    // viewport 150 → maxViewportH = 14 → effectiveMin = 14
    expect(clampPanelHeight(300, 150)).toBe(14);
  });
});

// ---------------------------------------------------------------------------
// resolveInitialPanelHeight
// ---------------------------------------------------------------------------

describe('resolveInitialPanelHeight', () => {
  it('returns saved value when within bounds on tall viewport', () => {
    expect(resolveInitialPanelHeight('450', 1080)).toBe(450);
  });

  it('returns default when no saved value on tall viewport', () => {
    expect(resolveInitialPanelHeight(null, 1080)).toBe(PANEL_DEFAULT_H); // 400
  });

  it('clamps saved value above MAX down to MAX', () => {
    expect(resolveInitialPanelHeight('900', 1080)).toBe(PANEL_MAX_H); // 700
  });

  it('clamps saved value below MIN up to MIN on tall viewport', () => {
    expect(resolveInitialPanelHeight('100', 1080)).toBe(PANEL_MIN_H); // 200
  });

  it('preserves saved height below PANEL_MIN_H on short viewport', () => {
    // viewport 300 → maxViewportH = 164, effectiveMin = 164
    // saved 164 → clamp(164, 164) = 164
    expect(resolveInitialPanelHeight('164', 300)).toBe(164);
  });

  it('re-clamps short-viewport save to MIN when loaded on tall viewport', () => {
    // User saved 164 on short screen, now on 1080px:
    // effectiveMin = 200 → saved 164 < 200 → clamped to 200
    expect(resolveInitialPanelHeight('164', 1080)).toBe(PANEL_MIN_H); // 200
  });

  it('returns clamped default on short viewport with no saved value', () => {
    // viewport 300 → maxViewportH = 164
    // default 400 → clamped to 164
    expect(resolveInitialPanelHeight(null, 300)).toBe(164);
  });

  it('handles invalid saved value (NaN) by falling back to default', () => {
    expect(resolveInitialPanelHeight('abc', 1080)).toBe(PANEL_DEFAULT_H);
  });

  it('handles invalid saved value (negative) by falling back to default', () => {
    expect(resolveInitialPanelHeight('-50', 1080)).toBe(PANEL_DEFAULT_H);
  });

  it('handles invalid saved value (zero) by falling back to default', () => {
    expect(resolveInitialPanelHeight('0', 1080)).toBe(PANEL_DEFAULT_H);
  });

  it('handles invalid saved value (Infinity) by falling back to default', () => {
    expect(resolveInitialPanelHeight('Infinity', 1080)).toBe(PANEL_DEFAULT_H);
  });
});
