import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCSS } from '../oklch-tuner-css';
import { INIT_LIGHT } from '../oklch-tuner-engine';
import * as nameRole from '../oklch-tuner-name-role';

/**
 * Cloud review of #5086, round 4 (P2): one CSS build resolved the nameplate four times (once per mode for the plate and the
 * name, once more per mode inside the lineage ring just to recover the plate lightness). The resolver is the expensive call,
 * so each mode is resolved once and the ring is handed that mode's plate lightness.
 */
vi.mock('../oklch-tuner-name-role', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../oklch-tuner-name-role')>();
  return { ...actual, resolveTunerNameAndPlate: vi.fn(actual.resolveTunerNameAndPlate) };
});

const NO_HC = { on: false, hue: 0, chroma: 0 };
const ROOM = {
  cats: [
    { h: 250, c: 0.12 },
    { h: 25, c: 0.15 },
  ],
  human: { h: 58, c: 0.04 },
};

describe('buildCSS resolves the nameplate once per mode', () => {
  beforeEach(() => {
    // A block body, not an expression: a function returned from beforeEach is run as the teardown (with no arguments).
    vi.mocked(nameRole.resolveTunerNameAndPlate).mockClear();
  });

  it('two resolutions for a build against a known room (light and dark), not four', () => {
    buildCSS(structuredClone(INIT_LIGHT), NO_HC, ROOM);

    expect(nameRole.resolveTunerNameAndPlate).toHaveBeenCalledTimes(2);
  });

  it('two resolutions for the swept fallback too', () => {
    buildCSS(structuredClone(INIT_LIGHT), NO_HC);

    expect(nameRole.resolveTunerNameAndPlate).toHaveBeenCalledTimes(2);
  });
});
