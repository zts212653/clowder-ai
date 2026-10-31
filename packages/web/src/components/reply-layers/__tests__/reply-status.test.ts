/**
 * F322 B — §1.16 合同二/合同三, the truth table of the one line that says what a reply is doing.
 *
 * A reply has a status line only while it is running or when it did not end well; a reply that finished normally says nothing.
 * The inputs are facts of THIS reply (its own stream flag, its own reconciliation phase, its own error, and a "went quiet"
 * fact the caller has already tied to this reply's own turn) — nothing here reads a store, so a status can never be borrowed
 * from another cat or from the cat's next run.
 */
import { describe, expect, it } from 'vitest';
import { deriveReplyExecutionState, deriveReplyStatus, type ReplyStatusInput } from '../reply-status';

const base: ReplyStatusInput = {
  streaming: false,
  status: undefined,
  errored: false,
  failure: { reasonCode: undefined, timeoutDiagnostics: false },
  quiet: null,
  now: 10_000_000,
  latestToolUse: null,
};
const input = (over: Partial<ReplyStatusInput>): ReplyStatusInput => ({ ...base, ...over });

describe('deriveReplyStatus', () => {
  it.each([
    [{ streaming: true, status: 'completed', errored: false }, 'terminal'],
    [{ streaming: true, status: 'canceled', errored: false }, 'terminal'],
    [{ streaming: true, status: 'failed', errored: false }, 'terminal'],
    [{ streaming: false, status: 'processing', errored: false }, 'running'],
    [{ streaming: false, status: 'interrupted', errored: false }, 'terminal'],
  ] as const)('derives one canonical execution state from %o', (facts, expected) => {
    expect(deriveReplyExecutionState(facts)).toBe(expected);
  });

  it('a reply that finished normally says nothing, with or without a recorded succeeded phase', () => {
    expect(deriveReplyStatus(base)).toBeNull();
    expect(deriveReplyStatus(input({ status: 'completed' }))).toBeNull();
    expect(deriveReplyStatus(input({ status: 'completed', streaming: true }))).toBeNull();
  });

  describe('processing', () => {
    it('before any tool call it is writing the reply', () => {
      expect(deriveReplyStatus(input({ streaming: true }))).toEqual({ kind: 'working', action: null });
    });

    it('with a tool call it is that tool call, as a verb with complete detail for the tooltip', () => {
      const status = deriveReplyStatus(
        input({ streaming: true, latestToolUse: { label: 'Bash', detail: JSON.stringify({ command: 'pnpm test' }) } }),
      );
      expect(status).toEqual({
        kind: 'working',
        action: { kind: 'run', tool: 'Bash', detail: JSON.stringify({ command: 'pnpm test' }), object: 'pnpm' },
      });
    });

    it('a canonical "running" phase is running even when the stream flag is gone', () => {
      expect(deriveReplyStatus(input({ status: 'processing' }))).toEqual({ kind: 'working', action: null });
    });

    it('went quiet: the quiet fact replaces the verb, with the minutes only when the start of the silence is known', () => {
      expect(deriveReplyStatus(input({ streaming: true, quiet: { since: 10_000_000 - 3 * 60_000 - 5_000 } }))).toEqual({
        kind: 'quiet',
        quietForMs: 3 * 60_000 + 5_000,
      });
      expect(deriveReplyStatus(input({ streaming: true, quiet: { since: null } }))).toEqual({
        kind: 'quiet',
        quietForMs: null,
      });
    });

    it('a quiet fact on a reply that is not running is not a status', () => {
      expect(deriveReplyStatus(input({ quiet: { since: 1 } }))).toBeNull();
    });
  });

  describe("can't be checked", () => {
    it('unknown_running wins over a stream flag that nothing is feeding any more', () => {
      expect(deriveReplyStatus(input({ streaming: true, status: 'interrupted' }))).toEqual({ kind: 'stopped' });
      expect(deriveReplyStatus(input({ status: 'interrupted' }))).toEqual({ kind: 'stopped' });
    });
  });

  describe('did not end well', () => {
    it('failed by the canonical phase, or by the message itself being an error', () => {
      expect(deriveReplyStatus(input({ status: 'failed' }))).toEqual({ kind: 'failed', reason: null });
      expect(deriveReplyStatus(input({ errored: true }))).toEqual({ kind: 'failed', reason: null });
    });

    it('names the reason when the diagnostics carry one of the three it knows', () => {
      const failed = (reasonCode: string | undefined, timeoutDiagnostics = false) =>
        deriveReplyStatus(input({ status: 'failed', failure: { reasonCode, timeoutDiagnostics } }));
      expect(failed('cli_response_timeout')).toEqual({ kind: 'failed', reason: 'response_timeout' });
      expect(failed('cli_stall_timeout')).toEqual({ kind: 'failed', reason: 'stall_timeout' });
      expect(failed('silent_completion')).toEqual({ kind: 'failed', reason: 'silent_completion' });
      expect(failed(undefined, true)).toEqual({ kind: 'failed', reason: 'response_timeout' });
    });

    it('a reason it does not know is not guessed: "did not finish" without one', () => {
      expect(
        deriveReplyStatus(
          input({ status: 'failed', failure: { reasonCode: 'auth_failed', timeoutDiagnostics: false } }),
        ),
      ).toEqual({ kind: 'failed', reason: null });
    });

    it('stopped says stopped, and does not say who stopped it', () => {
      expect(deriveReplyStatus(input({ status: 'canceled' }))).toEqual({ kind: 'stopped' });
    });

    it('precedence: stopped > failed > cannot be checked > running', () => {
      expect(deriveReplyStatus(input({ status: 'canceled', errored: true, streaming: true }))).toEqual({
        kind: 'stopped',
      });
      expect(deriveReplyStatus(input({ status: 'failed', streaming: true, quiet: { since: null } }))).toEqual({
        kind: 'failed',
        reason: null,
      });
      expect(deriveReplyStatus(input({ errored: true, status: 'interrupted' }))).toEqual({ kind: 'stopped' });
    });
  });
});
