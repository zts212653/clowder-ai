/**
 * F102 Phase J: MemoryHub import liveness — verifies component wiring.
 */

import { describe, expect, it } from 'vitest';

describe('MemoryHub module wiring', () => {
  it('MemoryHub exports correctly', async () => {
    const mod = await import('@/components/memory/MemoryHub');
    expect(typeof mod.MemoryHub).toBe('function');
  });

  it('MemoryNav exports pure helpers', async () => {
    const mod = await import('@/components/memory/MemoryNav');
    expect(typeof mod.MemoryNav).toBe('function');
    expect(typeof mod.resolveReferrerThread).toBe('function');
    expect(typeof mod.buildBackHref).toBe('function');
    expect(typeof mod.buildMemoryTabItems).toBe('function');
  });

  it('MemoryIcon exports correctly', async () => {
    const mod = await import('@/components/icons/MemoryIcon');
    expect(typeof mod.MemoryIcon).toBe('function');
  });

  it('route pages export default components', async () => {
    const feed = await import('@/app/memory/page');
    expect(typeof feed.default).toBe('function');
    const search = await import('@/app/memory/search/page');
    expect(typeof search.default).toBe('function');
    const status = await import('@/app/memory/status/page');
    expect(typeof status.default).toBe('function');
  });
});
