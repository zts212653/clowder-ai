/**
 * F258 Visible Café — INV-7: Star lights cap
 *
 * Prevents rendering 1246 threads as star lights.
 * Cap at MAX_STAR_LIGHTS (24).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_STAR_LIGHTS } from '@/lib/visible-cafe/presence-types';
import { useVisibleCafePresenceStore } from '@/stores/visible-cafe-presence';

describe('INV-7: star lights cap', () => {
  beforeEach(() => {
    useVisibleCafePresenceStore.getState().reset();
  });

  it(`MAX_STAR_LIGHTS is ${MAX_STAR_LIGHTS}`, () => {
    expect(MAX_STAR_LIGHTS).toBe(24);
  });

  it('setStarLights caps at MAX_STAR_LIGHTS', () => {
    const store = useVisibleCafePresenceStore.getState();

    // Create 50 star lights
    const lights = Array.from({ length: 50 }, (_, i) => ({
      threadId: `thread_${i}`,
      brightness: 0.5,
      x: i / 50,
      y: i / 50,
    }));

    store.setStarLights(lights);

    const result = useVisibleCafePresenceStore.getState().starLights;
    expect(result).toHaveLength(MAX_STAR_LIGHTS);
  });

  it('fewer than cap → all kept', () => {
    const store = useVisibleCafePresenceStore.getState();
    const lights = Array.from({ length: 5 }, (_, i) => ({
      threadId: `thread_${i}`,
      brightness: 0.8,
      x: 0.1 * i,
      y: 0.2 * i,
    }));

    store.setStarLights(lights);
    expect(useVisibleCafePresenceStore.getState().starLights).toHaveLength(5);
  });
});
