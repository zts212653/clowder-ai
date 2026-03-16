import { describe, expect, it } from 'vitest';
import { deriveGodButtons } from '@/components/game/GodInspector';

describe('God Inspector button visibility', () => {
  it('shows pause and skip when playing', () => {
    const result = deriveGodButtons('playing');
    expect(result.showPause).toBe(true);
    expect(result.showResume).toBe(false);
    expect(result.showSkip).toBe(true);
  });

  it('shows only resume when paused', () => {
    const result = deriveGodButtons('paused');
    expect(result.showPause).toBe(false);
    expect(result.showResume).toBe(true);
    expect(result.showSkip).toBe(false);
  });

  it('shows no buttons when finished', () => {
    const result = deriveGodButtons('finished');
    expect(result.showPause).toBe(false);
    expect(result.showResume).toBe(false);
    expect(result.showSkip).toBe(false);
  });

  it('shows no buttons in lobby', () => {
    const result = deriveGodButtons('lobby');
    expect(result.showPause).toBe(false);
    expect(result.showResume).toBe(false);
    expect(result.showSkip).toBe(false);
  });
});
