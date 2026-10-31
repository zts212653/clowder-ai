import { describe, expect, it } from 'vitest';

describe('WorldPanel', () => {
  it('exports WorldPanel component', async () => {
    const mod = await import('../WorldPanel');
    expect(mod.WorldPanel).toBeDefined();
    expect(typeof mod.WorldPanel).toBe('function');
  });
});
