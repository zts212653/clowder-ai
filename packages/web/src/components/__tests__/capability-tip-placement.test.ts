import { describe, expect, it } from 'vitest';
import { getStreamingTipContexts, isStreamingTipSuppressed } from '../capability-tip-placement';

describe('F244 capability tip placement', () => {
  it('uses review contexts for ideate mode', () => {
    expect(getStreamingTipContexts('ideate')).toEqual(['review', 'long_running']);
    expect(getStreamingTipContexts('execute')).toEqual(['thinking', 'long_running']);
  });

  it('defaults to thinking contexts for null/undefined intentMode', () => {
    expect(getStreamingTipContexts(null)).toEqual(['thinking', 'long_running']);
    expect(getStreamingTipContexts(undefined)).toEqual(['thinking', 'long_running']);
  });

  it('suppresses tips for suspected_stall and alive_but_silent', () => {
    expect(isStreamingTipSuppressed('suspected_stall')).toBe(true);
    expect(isStreamingTipSuppressed('alive_but_silent')).toBe(true);
    expect(isStreamingTipSuppressed('streaming')).toBe(false);
    expect(isStreamingTipSuppressed(undefined)).toBe(false);
  });

  it('suppresses tips for an app-server turn that stays active past the silence threshold', () => {
    const now = 1_000_000;
    const lifecycle = {
      stage: 'active' as const,
      lastActivityAt: now - 120_001,
      recoveryAttempt: 0,
      turnStartSent: true,
      turnAccepted: true,
      itemObserved: false,
    };

    expect(isStreamingTipSuppressed('streaming', lifecycle, now)).toBe(true);
  });
});
