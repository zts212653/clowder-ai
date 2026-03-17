/**
 * PlayerGrid Action Status Tests (F101 Phase F — Task 7)
 *
 * Tests deriveActionStatusClass() and deriveSeatStatus() with ActionStatus.
 */

import { describe, it, expect } from 'vitest';
import { deriveActionStatusClass, deriveSeatStatus } from '../PlayerGrid';

describe('deriveActionStatusClass', () => {
  it('waiting → pulse-gray', () => {
    expect(deriveActionStatusClass('waiting')).toBe('pulse-gray');
  });

  it('acting → pulse-yellow', () => {
    expect(deriveActionStatusClass('acting')).toBe('pulse-yellow');
  });

  it('acted → solid-green', () => {
    expect(deriveActionStatusClass('acted')).toBe('solid-green');
  });

  it('timed_out → solid-red', () => {
    expect(deriveActionStatusClass('timed_out')).toBe('solid-red');
  });

  it('fallback → solid-orange', () => {
    expect(deriveActionStatusClass('fallback')).toBe('solid-orange');
  });

  it('undefined → empty string', () => {
    expect(deriveActionStatusClass(undefined)).toBe('');
  });
});

describe('deriveSeatStatus with actionStatus', () => {
  it('uses actionStatus text when available', () => {
    const result = deriveSeatStatus({ alive: true, gameStatus: 'playing', actionStatus: 'acted' });
    expect(result).toBe('✓ 已行动');
  });

  it('shows waiting status', () => {
    const result = deriveSeatStatus({ alive: true, gameStatus: 'playing', actionStatus: 'waiting' });
    expect(result).toBe('等待');
  });

  it('shows acting status', () => {
    const result = deriveSeatStatus({ alive: true, gameStatus: 'playing', actionStatus: 'acting' });
    expect(result).toBe('行动中…');
  });

  it('shows timed_out status', () => {
    const result = deriveSeatStatus({ alive: true, gameStatus: 'playing', actionStatus: 'timed_out' });
    expect(result).toBe('超时');
  });

  it('shows fallback status', () => {
    const result = deriveSeatStatus({ alive: true, gameStatus: 'playing', actionStatus: 'fallback' });
    expect(result).toBe('系统代行');
  });

  it('dead always shows 死亡 regardless of actionStatus', () => {
    const result = deriveSeatStatus({ alive: false, actionStatus: 'acted' });
    expect(result).toBe('死亡');
  });
});
