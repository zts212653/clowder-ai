/**
 * F322 B — §1.16 第 3 层 "怎么干的": what the collapsed record line counts and what the opened record lists, from the same
 * `toolEvents` the old CLI block was fed. The count is of calls the user can see (an "unknown" tool call is not shown anywhere,
 * as before), an error is a result the provider marked as an error, and the duration is the turn's own — never the spread of
 * the tool timestamps (a single call would read 0s).
 */
import { describe, expect, it } from 'vitest';
import type { ToolEvent } from '@/stores/chat-types';
import { summarizeReplyRecord } from '../reply-record';

const use = (id: string, label: string, detail?: string, toolUseId?: string): ToolEvent => ({
  id,
  type: 'tool_use',
  label,
  detail,
  toolUseId,
  timestamp: 1_000,
});
const result = (
  id: string,
  detail: string | undefined,
  status?: 'completed' | 'error',
  toolUseId?: string,
): ToolEvent => ({
  id,
  type: 'tool_result',
  label: `${id} result`,
  detail,
  status,
  toolUseId,
  timestamp: 1_001,
});

describe('summarizeReplyRecord', () => {
  it('no tool calls: nothing to count', () => {
    expect(summarizeReplyRecord(undefined, undefined)).toMatchObject({ toolCount: 0, errorCount: 0, rows: [] });
    expect(summarizeReplyRecord([], undefined).toolCount).toBe(0);
  });

  it('counts tool calls, and counts a result marked as an error', () => {
    const summary = summarizeReplyRecord(
      [use('t1', 'Bash'), result('r1', 'ok', 'completed'), use('t2', 'Read'), result('r2', 'no such file', 'error')],
      undefined,
    );
    expect(summary.toolCount).toBe(2);
    expect(summary.errorCount).toBe(1);
  });

  it('a tool call the CLI block never showed ("unknown") is not counted, nor is its result', () => {
    const summary = summarizeReplyRecord(
      [use('t1', 'unknown'), result('r1', 'x', 'error'), use('t2', 'Edit'), result('r2', 'done')],
      undefined,
    );
    expect(summary.toolCount).toBe(1);
    expect(summary.errorCount).toBe(0);
    expect(summary.rows.map((row) => row.id)).toEqual(['t2']);
  });

  it('rows are the calls in order, each with its projected label and the detail of its result', () => {
    const summary = summarizeReplyRecord(
      [
        use('t1', 'Bash', JSON.stringify({ command: 'pnpm test' })),
        result('r1', 'exit 0'),
        use('t2', 'Edit', JSON.stringify({ file_path: '/a.ts' })),
      ],
      undefined,
    );
    expect(summary.rows).toEqual([
      { id: 't1', label: 'Bash pnpm test', detail: 'exit 0', failed: false, settled: true },
      { id: 't2', label: 'Edit /a.ts', detail: JSON.stringify({ file_path: '/a.ts' }), failed: false, settled: false },
    ]);
  });

  it('pairs a result with its own call by the provider key when the results arrive out of order', () => {
    const summary = summarizeReplyRecord(
      [
        use('t1', 'Read', undefined, 'k1'),
        use('t2', 'Bash', undefined, 'k2'),
        result('r2', 'second', 'error', 'k2'),
        result('r1', 'first', 'completed', 'k1'),
      ],
      undefined,
    );
    expect(summary.rows.map((row) => [row.id, row.detail, row.failed])).toEqual([
      ['t1', 'first', false],
      ['t2', 'second', true],
    ]);
  });

  it('pairs unkeyed parallel calls and results in FIFO order', () => {
    const summary = summarizeReplyRecord(
      [use('t1', 'Read'), use('t2', 'Bash'), result('r1', 'first', 'completed'), result('r2', 'second', 'error')],
      undefined,
    );
    expect(summary.rows.map((row) => [row.id, row.detail, row.failed, row.settled])).toEqual([
      ['t1', 'first', false, true],
      ['t2', 'second', true, true],
    ]);
  });

  it('never falls a keyed orphan result back onto an unrelated unkeyed call', () => {
    const summary = summarizeReplyRecord(
      [use('t1', 'Read'), result('orphan', 'not t1', 'error', 'missing-key')],
      undefined,
    );
    expect(summary.rows).toEqual([{ id: 't1', label: 'Read', failed: false, settled: false }]);
  });

  describe('duration', () => {
    const withUsage = (durationMs: number | undefined) => ({
      provider: 'anthropic',
      model: 'claude',
      usage: { durationMs },
    });
    it("is the turn's own, from the usage the provider reported", () => {
      expect(summarizeReplyRecord([use('t1', 'Bash')], withUsage(402_000)).durationMs).toBe(402_000);
    });
    it('is absent when it is not there, zero, or not a number — nothing is derived from tool timestamps', () => {
      expect(summarizeReplyRecord([use('t1', 'Bash')], undefined).durationMs).toBeNull();
      expect(summarizeReplyRecord([use('t1', 'Bash')], withUsage(undefined)).durationMs).toBeNull();
      expect(summarizeReplyRecord([use('t1', 'Bash')], withUsage(0)).durationMs).toBeNull();
      expect(summarizeReplyRecord([use('t1', 'Bash')], withUsage(Number.NaN)).durationMs).toBeNull();
    });
  });

  describe('F319: rerouted (the upstream answered with another model)', () => {
    const meta = (model: string, servedModel?: string) => ({ provider: 'openai', model, servedModel });
    it('true only when both are known and differ, ignoring case and padding', () => {
      expect(summarizeReplyRecord([], meta('gpt-5.6-sol', 'gpt-6-sol')).rerouted).toBe(true);
      expect(summarizeReplyRecord([], meta('gpt-5.6-sol', 'GPT-5.6-SOL')).rerouted).toBe(false);
      expect(summarizeReplyRecord([], meta(' gpt-5.6-sol ', 'gpt-5.6-sol')).rerouted).toBe(false);
    });
    it('false when nothing was observed, or nothing was requested to compare with', () => {
      expect(summarizeReplyRecord([], meta('gpt-5.6-sol', undefined)).rerouted).toBe(false);
      expect(summarizeReplyRecord([], meta('', 'gpt-6-sol')).rerouted).toBe(false);
      expect(summarizeReplyRecord([], undefined).rerouted).toBe(false);
    });
  });
});
