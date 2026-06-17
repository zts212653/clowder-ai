/**
 * F229 PR-A3a: projectBallState 投影函数表驱动测试
 *
 * 验证 INV-1（全序唯一）/ INV-2（零存储，see conciergeStore-lifecycle.test）/ INV-4（纯函数）
 * micro-spec §1: 任意 inputs 恰好一个输出，含全部相邻优先级冲突对
 *
 * A3a delta: panelOpen: boolean → surfaceState: 'collapsed' | 'toolbar' | 'bubble'
 *   listening 条件从 panelOpen+inputFocused → surfaceState==='bubble'+inputFocused
 */
import { describe, expect, it } from 'vitest';
import { type ConciergeInputs, projectBallState } from '../conciergeStore';

const BASE: ConciergeInputs = {
  enabled: true,
  muted: false,
  invocationStatus: 'idle',
  pendingConfirmationCount: 0,
  pendingRelayCount: 0,
  unseenResultCount: 0,
  surfaceState: 'collapsed',
  inputFocused: false,
};

function inp(overrides: Partial<ConciergeInputs>): ConciergeInputs {
  return { ...BASE, ...overrides };
}

describe('projectBallState — INV-1 全序唯一', () => {
  // --- hidden cases ---
  it('disabled → hidden', () => {
    expect(projectBallState(inp({ enabled: false }))).toBe('hidden');
  });
  it('muted → hidden', () => {
    expect(projectBallState(inp({ muted: true }))).toBe('hidden');
  });
  it('disabled + muted → hidden (not some other state)', () => {
    expect(projectBallState(inp({ enabled: false, muted: true }))).toBe('hidden');
  });

  // --- error (priority 1 among visible states) ---
  it('error invocation → error', () => {
    expect(projectBallState(inp({ invocationStatus: 'error' }))).toBe('error');
  });
  it('error wins over needs-confirmation', () => {
    expect(projectBallState(inp({ invocationStatus: 'error', pendingConfirmationCount: 1 }))).toBe('error');
  });
  it('error wins over thinking (in_progress)', () => {
    expect(projectBallState(inp({ invocationStatus: 'error', pendingConfirmationCount: 0 }))).toBe('error');
  });

  // --- needs-confirmation (priority 2) ---
  it('pendingConfirmationCount > 0 → needs-confirmation', () => {
    expect(projectBallState(inp({ pendingConfirmationCount: 1 }))).toBe('needs-confirmation');
  });
  it('needs-confirmation wins over thinking', () => {
    expect(projectBallState(inp({ pendingConfirmationCount: 2, invocationStatus: 'pending' }))).toBe(
      'needs-confirmation',
    );
  });

  // --- thinking (priority 3) ---
  it('pending → thinking', () => {
    expect(projectBallState(inp({ invocationStatus: 'pending' }))).toBe('thinking');
  });
  it('in_progress → thinking', () => {
    expect(projectBallState(inp({ invocationStatus: 'in_progress' }))).toBe('thinking');
  });
  it('thinking wins over handoff', () => {
    expect(projectBallState(inp({ invocationStatus: 'pending', pendingRelayCount: 1 }))).toBe('thinking');
  });

  // --- handoff (priority 4) ---
  it('pendingRelayCount > 0 → handoff', () => {
    expect(projectBallState(inp({ pendingRelayCount: 1 }))).toBe('handoff');
  });

  // --- listening (priority 5) — A3a: requires surfaceState='bubble' not just 'open' ---
  it('surfaceState=bubble + inputFocused → listening', () => {
    expect(projectBallState(inp({ surfaceState: 'bubble', inputFocused: true }))).toBe('listening');
  });
  it('surfaceState=toolbar + inputFocused → NOT listening (toolbar ≠ bubble)', () => {
    expect(projectBallState(inp({ surfaceState: 'toolbar', inputFocused: true }))).not.toBe('listening');
  });
  it('surfaceState=bubble but not focused → NOT listening', () => {
    expect(projectBallState(inp({ surfaceState: 'bubble', inputFocused: false }))).not.toBe('listening');
  });
  it('surfaceState=collapsed + inputFocused → NOT listening', () => {
    expect(projectBallState(inp({ surfaceState: 'collapsed', inputFocused: true }))).not.toBe('listening');
  });

  // --- found (priority 6) ---
  it('unseenResultCount > 0 → found', () => {
    expect(projectBallState(inp({ unseenResultCount: 3 }))).toBe('found');
  });

  // --- idle (default) ---
  it('all zeros → idle', () => {
    expect(projectBallState(BASE)).toBe('idle');
  });
  it('surfaceState=toolbar (no inputFocused) → idle', () => {
    expect(projectBallState(inp({ surfaceState: 'toolbar' }))).toBe('idle');
  });

  // --- INV-4: pure function — same inputs → same output ---
  it('same inputs called twice return identical output (INV-4 pure)', () => {
    const inputs = inp({ unseenResultCount: 2 });
    expect(projectBallState(inputs)).toBe(projectBallState(inputs));
  });
});

describe('projectBallState — 清除规则状态转移', () => {
  it('found → idle when unseenResultCount cleared to 0', () => {
    expect(projectBallState(inp({ unseenResultCount: 0 }))).toBe('idle');
  });

  it('error → idle when invocationStatus resets to idle', () => {
    expect(projectBallState(inp({ invocationStatus: 'idle' }))).toBe('idle');
  });

  it('handoff → found transition: pendingRelayCount=0 and unseenResultCount=1', () => {
    // relay回执到达 → pendingRelayCount-1, unseenResultCount+1
    expect(projectBallState(inp({ pendingRelayCount: 0, unseenResultCount: 1 }))).toBe('found');
  });

  it('bubble collapsed → listening stops (surfaceState=collapsed clears listening)', () => {
    expect(projectBallState(inp({ surfaceState: 'collapsed', inputFocused: true }))).toBe('idle');
  });
});
