import { describe, expect, it } from 'vitest';
import { getStreamingTipContexts, isStreamingTipSuppressedByStatus } from '../capability-tip-placement';

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
    expect(isStreamingTipSuppressedByStatus('suspected_stall')).toBe(true);
    expect(isStreamingTipSuppressedByStatus('alive_but_silent')).toBe(true);
    expect(isStreamingTipSuppressedByStatus('streaming')).toBe(false);
    expect(isStreamingTipSuppressedByStatus(undefined)).toBe(false);
  });
});
