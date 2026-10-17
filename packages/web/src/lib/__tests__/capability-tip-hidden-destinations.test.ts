import { validateCapabilityTipInventory } from '@cat-cafe/shared';
import { describe, expect, it } from 'vitest';
import { CAPABILITY_SURFACE_ROUTES, HIDDEN_TIP_DESTINATIONS, isHiddenTipDestination } from '../capability-tip-surfaces';
import rawTips from '../capability-tips.seed.json';

describe('F190 hidden destination promotion guard', () => {
  it('keeps the production inventory and surface routes free of hidden destinations', () => {
    for (const [surfaceId, href] of Object.entries(CAPABILITY_SURFACE_ROUTES)) {
      expect(isHiddenTipDestination(surfaceId), surfaceId).toBe(false);
      expect(isHiddenTipDestination(href), href).toBe(false);
    }
    const inventory = validateCapabilityTipInventory(rawTips);
    if (!inventory.success) throw new Error(inventory.errors.join('\n'));
    if (!inventory.tips) throw new Error('Missing capability tip inventory');
    for (const tip of inventory.tips) {
      if (tip.action?.type === 'open_capability_surface') {
        expect(isHiddenTipDestination(tip.action.surfaceId), tip.id).toBe(false);
      }
      for (const path of Object.values(HIDDEN_TIP_DESTINATIONS)) {
        expect(tip.body.includes(path), tip.id).toBe(false);
      }
    }
  });

  it.each(Object.entries(HIDDEN_TIP_DESTINATIONS))('blocks %s and its deep-link variants', (surfaceId, path) => {
    for (const target of [surfaceId, path, `${path}/detail`, `${path}?from=thread`, `${path}#entry`]) {
      expect(isHiddenTipDestination(target), target).toBe(true);
    }
    expect(isHiddenTipDestination(`${path}-unrelated`)).toBe(false);
  });
});
