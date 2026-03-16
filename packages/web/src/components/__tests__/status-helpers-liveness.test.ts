import { describe, expect, it } from 'vitest';
import { statusLabel, statusTone } from '../status-helpers';

describe('statusLabel — liveness states (F118 AC-C1)', () => {
  it('returns 静默等待 for alive_but_silent', () => {
    expect(statusLabel('alive_but_silent')).toBe('静默等待');
  });

  it('returns 疑似卡住 for suspected_stall', () => {
    expect(statusLabel('suspected_stall')).toBe('疑似卡住');
  });
});

describe('statusTone — liveness states (F118 AC-C1)', () => {
  it('returns amber for alive_but_silent', () => {
    expect(statusTone('alive_but_silent')).toBe('text-amber-500');
  });

  it('returns orange for suspected_stall', () => {
    expect(statusTone('suspected_stall')).toBe('text-orange-600');
  });
});
