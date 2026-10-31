import { describe, expect, it } from 'vitest';
import {
  EXPLICIT_STOP_GESTURES,
  EXPLICIT_STOP_SOURCE_CONTROLS,
  isExplicitStopGesture,
  isExplicitStopSourceControl,
} from '../explicit-stop-intent.js';

describe('explicit Stop intent contract', () => {
  it('accepts every first-party control and gesture in the shared contract', () => {
    for (const control of EXPLICIT_STOP_SOURCE_CONTROLS) expect(isExplicitStopSourceControl(control)).toBe(true);
    for (const gesture of EXPLICIT_STOP_GESTURES) expect(isExplicitStopGesture(gesture)).toBe(true);
  });

  it('rejects unknown or untyped provenance', () => {
    expect(isExplicitStopSourceControl('reconnect_cleanup')).toBe(false);
    expect(isExplicitStopSourceControl(undefined)).toBe(false);
    expect(isExplicitStopGesture('programmatic')).toBe(false);
    expect(isExplicitStopGesture(null)).toBe(false);
  });
});
