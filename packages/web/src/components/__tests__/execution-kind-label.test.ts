import type { ActiveExecutionProjection } from '@cat-cafe/shared';
import { describe, expect, it } from 'vitest';
import { executionActivityLabel, executionKindLabel } from '../execution-kind-label';

describe('execution kind labels shared by the execution bar and 正在发生', () => {
  it('names a live turn 实时回合 and a managed command 托管命令', () => {
    expect(executionKindLabel('live_invocation')).toBe('实时回合');
    expect(executionKindLabel('managed_command')).toBe('托管命令');
  });

  it('adds what a managed command runs, and nothing to a live turn', () => {
    expect(executionActivityLabel({ kind: 'live_invocation' })).toBe('实时回合');
    expect(executionActivityLabel({ kind: 'managed_command', activity: 'test' })).toBe('托管命令 · 测试');
    expect(executionActivityLabel({ kind: 'managed_command', activity: 'full_gate' })).toBe('托管命令 · 全量门禁');
  });

  it('does not repeat 托管命令 when the activity is the generic command or unknown', () => {
    expect(executionActivityLabel({ kind: 'managed_command', activity: 'command' })).toBe('托管命令');
    expect(executionActivityLabel({ kind: 'managed_command' })).toBe('托管命令');
    const future = 'future_activity' as unknown as ActiveExecutionProjection['activity'];
    expect(executionActivityLabel({ kind: 'managed_command', activity: future })).toBe('托管命令');
  });
});
