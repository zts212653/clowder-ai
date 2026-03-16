import { describe, expect, it } from 'vitest';
import { deriveSeatStatus } from '@/components/game/PlayerGrid';

describe('PlayerGrid seat status display', () => {
  it('shows "准备中" for ready seats in lobby', () => {
    expect(deriveSeatStatus({ alive: true, ready: true, gameStatus: 'lobby' })).toBe('准备中');
  });

  it('shows "加载中…" for not-ready seats in lobby', () => {
    expect(deriveSeatStatus({ alive: true, ready: false, gameStatus: 'lobby' })).toBe('加载中…');
  });

  it('shows "死亡" for dead seats regardless of phase', () => {
    expect(deriveSeatStatus({ alive: false, ready: true, gameStatus: 'playing' })).toBe('死亡');
  });

  it('shows "等待" for alive seats during playing', () => {
    expect(deriveSeatStatus({ alive: true, ready: true, gameStatus: 'playing' })).toBe('等待');
  });

  it('shows "暂停" during paused status', () => {
    expect(deriveSeatStatus({ alive: true, ready: true, gameStatus: 'paused' })).toBe('暂停');
  });
});
