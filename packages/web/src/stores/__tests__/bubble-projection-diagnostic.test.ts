/**
 * F194 Phase Z9 AC-Z24 — projection observability probe.
 *
 * Pure function that takes raw `ChatMessage[]` and outputs a diagnostic row per
 * record: `recordId / catId / origin / parentInvocationId / turnInvocationId /
 * projectionKey / contentHash`. Used to differentiate "missing key" vs
 * "projection path leak" failure modes when alpha re-test still splits.
 *
 * 砚砚 (Z9 R0)：先做小 evidence commit，再进 AC-Z25 backend stamp 修复。
 */
import { describe, expect, it } from 'vitest';
import { buildProjectionDiagnostic } from '../bubble-projection-diagnostic';
import type { ChatMessage } from '../chat-types';

describe('F194 Phase Z9 AC-Z24 — buildProjectionDiagnostic', () => {
  it('outputs one row per assistant record with all required fields', () => {
    const records: ChatMessage[] = [
      {
        id: 'msg-1',
        type: 'assistant',
        catId: 'codex',
        content: 'hello',
        timestamp: 100,
        origin: 'stream',
        extra: { stream: { invocationId: 'parent-z9', turnInvocationId: 'turn-codex-1' } },
      },
    ];
    const rows = buildProjectionDiagnostic({ records });
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.recordId).toBe('msg-1');
    expect(row.catId).toBe('codex');
    expect(row.origin).toBe('stream');
    expect(row.parentInvocationId).toBe('parent-z9');
    expect(row.turnInvocationId).toBe('turn-codex-1');
    expect(row.projectionKey).toBe('codex::turn-codex-1');
    expect(row.contentHash).toMatch(/^[a-f0-9]{8,}$/);
  });

  it('R13 reproduction: same parent + missing turn → projection key collapses to parent', () => {
    // co-creator catch："布偶猫1+布偶猫3 合并, 缅因猫2+缅因猫4 合并"
    // 诊断 thread_mp0o2lf7d2gu5j3y 真实形态：3 个跨 cat-turn record 共享 parent，全部 turnInvocationId=null
    const records: ChatMessage[] = [
      {
        id: 'rec-codex-t1',
        type: 'assistant',
        catId: 'codex',
        content: 'codex turn 1',
        timestamp: 100,
        origin: 'stream',
        extra: { stream: { invocationId: '7e1c4435' } },
      },
      {
        id: 'rec-sonnet-t2',
        type: 'assistant',
        catId: 'sonnet',
        content: 'sonnet turn 2',
        timestamp: 200,
        origin: 'stream',
        extra: { stream: { invocationId: '7e1c4435' } },
      },
      {
        id: 'rec-codex-t3',
        type: 'assistant',
        catId: 'codex',
        content: 'codex turn 3',
        timestamp: 300,
        origin: 'stream',
        extra: { stream: { invocationId: '7e1c4435' } },
      },
    ];
    const rows = buildProjectionDiagnostic({ records });
    expect(rows).toHaveLength(3);
    // codex turn1 and codex turn3 collapse to SAME projection key (the bug)
    expect(rows[0]!.projectionKey).toBe('codex::7e1c4435');
    expect(rows[2]!.projectionKey).toBe('codex::7e1c4435');
    expect(rows[0]!.projectionKey).toBe(rows[2]!.projectionKey);
    // sonnet has different cat → different key (legitimate)
    expect(rows[1]!.projectionKey).toBe('sonnet::7e1c4435');
    // All flagged as missing-turn for Z9 telemetry
    expect(rows.every((r) => r.missingTurnStamp)).toBe(true);
    // Content hash stable + differs per content
    expect(rows[0]!.contentHash).not.toBe(rows[2]!.contentHash);
  });

  it('handles legacy single-id stream record (no turn stamped)', () => {
    const records: ChatMessage[] = [
      {
        id: 'legacy-1',
        type: 'assistant',
        catId: 'opus',
        content: 'legacy',
        timestamp: 100,
        origin: 'stream',
        extra: { stream: { invocationId: 'inv-legacy' } },
      },
    ];
    const rows = buildProjectionDiagnostic({ records });
    expect(rows[0]!.parentInvocationId).toBe('inv-legacy');
    expect(rows[0]!.turnInvocationId).toBeUndefined();
    expect(rows[0]!.projectionKey).toBe('opus::inv-legacy');
    expect(rows[0]!.missingTurnStamp).toBe(true);
  });

  it('healthy case: turn stamped explicitly → no missingTurnStamp flag', () => {
    const records: ChatMessage[] = [
      {
        id: 'r1',
        type: 'assistant',
        catId: 'codex',
        content: 'turn 1',
        timestamp: 100,
        origin: 'stream',
        extra: { stream: { invocationId: 'parent-x', turnInvocationId: 'turn-codex-1' } },
      },
      {
        id: 'r2',
        type: 'assistant',
        catId: 'codex',
        content: 'turn 3',
        timestamp: 300,
        origin: 'stream',
        extra: { stream: { invocationId: 'parent-x', turnInvocationId: 'turn-codex-3' } },
      },
    ];
    const rows = buildProjectionDiagnostic({ records });
    expect(rows.every((r) => !r.missingTurnStamp)).toBe(true);
    // Different turn ids → different projection keys → no merge
    expect(rows[0]!.projectionKey).toBe('codex::turn-codex-1');
    expect(rows[1]!.projectionKey).toBe('codex::turn-codex-3');
    expect(rows[0]!.projectionKey).not.toBe(rows[1]!.projectionKey);
  });

  it('skips non-assistant records', () => {
    const records: ChatMessage[] = [
      { id: 'u1', type: 'user', content: 'hi', timestamp: 100 },
      { id: 's1', type: 'system', content: '[SYS]', timestamp: 200 },
      {
        id: 'a1',
        type: 'assistant',
        catId: 'codex',
        content: 'hi back',
        timestamp: 300,
        origin: 'stream',
        extra: { stream: { invocationId: 'inv-x' } },
      },
    ];
    const rows = buildProjectionDiagnostic({ records });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.recordId).toBe('a1');
  });
});
