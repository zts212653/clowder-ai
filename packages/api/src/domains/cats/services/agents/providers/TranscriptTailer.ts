/**
 * F198 Phase B Step 2 slice 2: TranscriptTailer
 *
 * Incremental reader for `claude --bg` transcript jsonl
 * (state.linkScanPath). Polled by `ClaudeBgCarrierService.invoke()` on
 * each tick to surface new assistant turns as the daemon writes them
 * (per-message streaming — R2 Hub observability constraint, 砚砚 slice-2
 * plan 2026-05-14).
 *
 * Strategy: re-read whole file, split by newline, slice from last
 * emitted index. transcripts are KB-scale append-only, so re-read cost
 * is negligible vs the alternative of stream-based tail (fs.watch is
 * platform-flaky for tail use). Same readiness pattern as
 * JobEventConsumer.readTimeline.
 *
 * Guarantees:
 * - File doesn't exist yet → empty (job hasn't spun up — caller polls)
 * - 1st call → all complete (newline-terminated) lines
 * - subsequent call → only NEW lines (no replay)
 * - partial last line (no trailing \n, daemon mid-write) → held back
 *   until next complete write — never JSON.parse a partial line
 * - malformed JSON line → skipped (per-line try/catch, same guard as
 *   JobEventConsumer.readTimeline)
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

export class TranscriptTailer {
  private emittedLines: number;

  /**
   * @param transcriptPath — path to the `.jsonl` transcript file.
   * @param initialEmittedLines — start reading from this line offset (default 0).
   *   Pass the number of existing lines when resuming a session to skip old content.
   *   Computed by PtyDriver.injectPrompt() using the same split('\n').slice(0,-1) logic.
   */
  constructor(
    public readonly transcriptPath: string,
    initialEmittedLines = 0,
  ) {
    this.emittedLines = initialEmittedLines;
  }

  /**
   * Read new entries.
   *
   * @param options.includeTrailingPartial — final-drain mode. When true,
   *   the segment after the last \n is also considered: if it JSON.parses
   *   successfully, treat as a complete line (handles daemon flush race
   *   where state=done was committed before transcript got its final \n).
   *   When false (default streaming mode), the trailing segment is held
   *   back as a partial — never JSON.parse a half-written line.
   *
   *   砚砚 slice-2 P1 (2026-05-14): without final-drain mode, success jobs
   *   with newline-less final lines went silent (only session_init + done
   *   emitted, no text).
   */
  async readNew(options: { includeTrailingPartial?: boolean } = {}): Promise<unknown[]> {
    if (!existsSync(this.transcriptPath)) return [];
    const content = await readFile(this.transcriptPath, 'utf8');
    const parts = content.split('\n');
    // Default: drop the last segment ('' if file ended with \n, partial if not).
    let completeLines = parts.slice(0, -1);

    if (options.includeTrailingPartial) {
      const trailing = parts[parts.length - 1];
      if (trailing) {
        // JSON-parse test: if it succeeds the line was truly complete (just
        // missing the trailing \n flush). If it fails the line is genuinely
        // partial — drop. This catches the daemon flush race without ever
        // surfacing a half-written line.
        try {
          JSON.parse(trailing);
          completeLines = [...completeLines, trailing];
        } catch {
          // truly partial — keep dropping until daemon completes the line
        }
      }
    }

    const newLines = completeLines.slice(this.emittedLines);
    // Monotonic: never regress emittedLines even if the next call is normal
    // (non-includeTrailingPartial) and completeLines.length is smaller than
    // what a previous includeTrailingPartial call already advanced to.
    // Without this, after a trailing-partial read advances emittedLines to N+1,
    // a subsequent normal read sets emittedLines = N (regression), causing the
    // same trailing line to be re-emitted on every poll. (F230 R7 P2)
    this.emittedLines = Math.max(this.emittedLines, completeLines.length);

    const entries: unknown[] = [];
    for (const line of newLines) {
      if (!line) continue; // blank line — skip
      try {
        entries.push(JSON.parse(line));
      } catch {
        // Per-line guard — skip malformed (matches JobEventConsumer pattern).
      }
    }
    return entries;
  }
}
