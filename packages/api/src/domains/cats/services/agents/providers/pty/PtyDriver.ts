/**
 * F230 Phase B: PtyDriver
 *
 * tmux wrapper that drives a real `claude` interactive session as a PTY.
 * Backup carrier for F198 `--bg` daemon — avoids the `-p` flag entirely,
 * billing identity stays `cli` (not `sdk-cli`).
 *
 * Platform support:
 *   ✅ macOS (bash/zsh) — primary development target
 *   ✅ Linux (bash/sh) — fully supported; POSIX single-quoting and
 *       `env -u` work identically on GNU coreutils + tmux
 *   ❌ Windows (native) — not supported: tmux has no native Windows port.
 *       Windows users should run under WSL (which uses the Linux path above).
 *       A ConPTY-based implementation for native Windows is Phase C+ scope.
 *
 * Design (spike F230 Phase A):
 *   - tmux session as PTY driver (verified full mechanism in spike)
 *   - Two-stage inject: load-buffer → paste-buffer → grace sleep → Enter
 *   - Transcript watch for injectPrompt ack (E5: p50 = 0.11s)
 *   - cancel() = send Escape (E5: session survives, "[Request interrupted by user]")
 *   - dispose() = kill-session (D1: 防僵尸, LL-056)
 *   - ALWAYS unset CLAUDE_CODE_ENTRYPOINT / CLAUDECODE (D3 + impl note 3)
 *
 * Implementation notes from spike:
 *   Note 1: ready probe = poll tmux list-panes + fixed grace (ready 10-15s)
 *   Note 2: injectPrompt three-step: load-buffer → paste-buffer → grace → Enter
 *           → fs.watch transcriptDir for new .jsonl (≤5s timeout, p50 0.11s)
 *   Note 3: env — unset CLAUDE_CODE_ENTRYPOINT / CLAUDECODE in spawn shell command
 *           (双保险: even if caller already deleted them, tmux server env may carry)
 *
 * Utility helpers (generateSessionName, buildClaudeCommand, tmux, tmuxSync,
 * snapshotTranscriptFiles, watchForTranscriptFile, isBypassConfirmationScreen, sleep)
 * live in ./pty-utils.ts to stay within the 350-line file limit.
 */
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createModuleLogger } from '../../../../../../infrastructure/logger.js';
import {
  acquireTranscriptDirWatch,
  buildClaudeCommand,
  generateSessionName,
  isBypassConfirmationScreen,
  sleep,
  snapshotTranscriptFiles,
  tmux,
  tmuxSync,
  watchForTranscriptFile,
} from './pty-utils.js';

// Re-export for test backward compatibility (f230-pty-driver-helpers.test.js
// imports isBypassConfirmationScreen from PtyDriver).
export { isBypassConfirmationScreen } from './pty-utils.js';

const log = createModuleLogger('pty-driver');

export interface PtyDriverOptions {
  cwd: string;
  /**
   * Env delta to apply inside the tmux session (string = set var, null = unset var).
   * This is the raw overrides map (NOT a full merged process.env).
   *
   * PtyDriver applies these in two ways:
   *   - string values → tmux new-session -e KEY=VALUE (set in pane env)
   *   - null values   → env -u KEY in the shell command (unset before claude runs)
   *
   * CLAUDE_CODE_ENTRYPOINT and CLAUDECODE should always be null here (enforced by
   * ClaudeInteractivePtyCarrierService before passing this to the driver).
   */
  env: Record<string, string | null>;
  claudeBinary?: string; // default 'claude'
  resumeSessionId?: string; // → `claude --resume <id>`
  extraArgs?: string[]; // --mcp-config etc, injected in Task 4
  readyTimeoutMs?: number; // default 30_000 (spike: ready 10-15s)
  /** Test seam: grace period after pane alive (ms). Default 15_000 (spike: ready 10-15s). */
  readyGraceMs?: number;
  /**
   * B-hook: skip watchForTranscriptFile ack after Enter.
   * When true, injectPrompt returns immediately with empty transcriptPath/sessionId.
   * The caller (CarrierService) gets sessionId from hook sidecar events instead.
   * Required for claude 2.1.172+ where interactive TUI no longer writes transcripts.
   */
  skipTranscriptAck?: boolean;
  /** Test seam: tmux session name prefix (default 'f230pty') */
  sessionPrefix?: string;
  /**
   * Test seam: extra grace period (ms) after accepting the bypassPermissions confirmation
   * menu. Default 5_000ms. Pass a small value in tests to speed them up.
   */
  bypassConfirmationGraceMs?: number;
}

interface InjectPromptResult {
  transcriptPath: string;
  sessionId: string;
  /**
   * P1-B fix: for resume sessions, the number of existing lines in the transcript
   * to skip on the first read. Passed to TranscriptTailer as initialEmittedLines.
   * Undefined (or 0) means start from the beginning (new session).
   */
  initialLines?: number;
}

export class PtyDriver {
  private sessionName: string | undefined;
  private disposed = false;

  constructor(private readonly opts: PtyDriverOptions) {}

  /**
   * Create tmux session + start claude.
   * Resolves when claude TUI is ready (ready probe: pane alive + grace period).
   *
   * Note 1: ready probe — poll `tmux list-panes` alive + fixed grace (10-15s spike data).
   * No screen scraping — grace is sufficient for the B-min skeleton.
   */
  async start(): Promise<void> {
    const prefix = this.opts.sessionPrefix ?? 'f230pty';
    this.sessionName = generateSessionName(prefix);
    const { cwd, readyTimeoutMs = 30_000 } = this.opts;
    const claudeCmd = buildClaudeCommand(this.opts);

    log.debug({ sessionName: this.sessionName, cwd, claudeCmd }, 'starting PTY session');

    // Build tmux new-session args.
    // String values in opts.env are injected via tmux -e KEY=VALUE (no shell quoting needed —
    // execFileAsync passes args directly to tmux without a shell).
    // Null values are handled by env -u in claudeCmd (built by buildClaudeCommand above).
    const tmuxNewSessionArgs: string[] = ['new-session', '-d', '-s', this.sessionName, '-c', cwd];
    for (const [key, value] of Object.entries(this.opts.env)) {
      if (value !== null && value !== undefined) {
        tmuxNewSessionArgs.push('-e', `${key}=${value}`);
      }
    }
    tmuxNewSessionArgs.push(claudeCmd);

    // Create detached tmux session running claude
    await tmux(...tmuxNewSessionArgs);

    // Ready probe: poll tmux list-panes until pane is alive, then grace period
    const graceMs = this.opts.readyGraceMs ?? 15_000; // spike: ready 10-15s
    const deadline = Date.now() + readyTimeoutMs;

    // Wait for pane to be alive (claude started)
    while (Date.now() < deadline) {
      const out = tmuxSync('list-panes', '-t', this.sessionName, '-F', '#{pane_id}');
      if (out.trim()) break;
      await sleep(200);
    }

    // Grace period for TUI to reach ❯ prompt
    await sleep(graceMs);

    // P1-A fix: handle bypassPermissions confirmation menu.
    // Claude TUI (2.1.170+) shows a menu with cursor on "❯ 1. No, exit" by default.
    // Plain Enter selects "No, exit" (exits session). Correct path:
    //   1. Send Down arrow to navigate cursor from "1. No, exit" to "2. Yes, I accept"
    //   2. Brief pause (100ms) for TUI to register cursor movement
    //   3. Send Enter to confirm "Yes, I accept"
    // On pre-warmed machines (consent already accepted) this screen does not appear.
    const paneContent = tmuxSync('capture-pane', '-t', this.sessionName, '-p');
    if (isBypassConfirmationScreen(paneContent)) {
      log.debug(
        { sessionName: this.sessionName },
        'bypass confirmation detected, sending Down+Enter to accept "2. Yes, I accept"',
      );
      // Down: move cursor from "1. No, exit" to "2. Yes, I accept"
      await tmux('send-keys', '-t', this.sessionName, 'Down');
      await sleep(100); // brief pause: let TUI register cursor movement
      // Enter: confirm selection
      await tmux('send-keys', '-t', this.sessionName, '', 'Enter');
      const bypassGraceMs = this.opts.bypassConfirmationGraceMs ?? 5_000;
      await sleep(bypassGraceMs);
      log.debug({ sessionName: this.sessionName }, 'bypass confirmation accepted, TUI ready');
    }

    log.debug({ sessionName: this.sessionName }, 'PTY session ready');
  }

  /**
   * Inject prompt via bracketed paste, wait for transcript ack.
   *
   * Note 2 three-step:
   *   ① Write text to temp file → tmux load-buffer → paste-buffer -p (bracketed paste)
   *   ② grace sleep (len/15KB seconds, min 2s) for TUI to consume the paste
   *   ③ snapshot existing .jsonl files + send-keys Enter (two-stage — paste + Enter separate)
   *   ④ watchForTranscriptFile: detect the first new .jsonl that appears after Enter
   *      → return {transcriptPath, sessionId} (sessionId = filename without .jsonl)
   *
   * F230 R10 root-cause fix (2026-06-11): `--session-id` is NOT used.
   * Claude's `--session-id <uuid>` writes only metadata (ai-title) to the named file;
   * conversation events go to a DIFFERENT file with Claude's own UUID.
   * watchForTranscriptFile detects whatever new file Claude creates after Enter.
   *
   * P1-B fix: resume sessions (`--resume <sessionId>`) append to an EXISTING transcript.
   * Return the known path immediately instead of waiting for a new file.
   */
  async injectPrompt(text: string, transcriptDir: string): Promise<InjectPromptResult> {
    if (!this.sessionName) throw new Error('PtyDriver: call start() before injectPrompt()');
    if (this.disposed) throw new Error('PtyDriver: session already disposed');

    // Serialize per-dir access (await queue, not fail-fast).
    // A concurrent same-dir caller WAITS here until the current holder releases —
    // it never touches tmux or sends Enter until it acquires the queue slot.
    // This prevents watchForTranscriptFile from racing to claim each other's .jsonl.
    const releaseDir = await acquireTranscriptDirWatch(transcriptDir);
    try {
      // P1-D fix (+ P2 lock-ordering fix): count resume transcript lines BEFORE submitting
      // the prompt, and INSIDE the dir-lock so concurrent resume callers see the correct offset.
      //
      // P1-D invariant: count BEFORE paste/Enter (not after) — Claude appends lines to the
      // existing transcript immediately after receiving Enter. Counting after Enter races with
      // those newly-written lines: they'd be included in `initialLines` and SKIPPED by
      // TranscriptTailer, causing lost response output or premature turn_duration detection.
      //
      // P2 lock-ordering fix: must be INSIDE the lock so concurrent resume callers see a
      // consistent offset. Without the lock, two concurrent callers can both read the line
      // count before either pastes; the second caller returns a stale `initialLines` that
      // excludes the first caller's appended lines, causing TranscriptTailer to re-read the
      // first turn's output as if it belonged to the second invocation.
      let preEnterResumeLines: number | undefined;
      if (this.opts.resumeSessionId) {
        const rPath = join(transcriptDir, `${this.opts.resumeSessionId}.jsonl`);
        if (existsSync(rPath)) {
          const content = await readFile(rPath, 'utf8');
          const parts = content.split('\n');
          // Count complete lines (same split logic as TranscriptTailer)
          let count = parts.slice(0, -1).length;
          // Also count trailing partial if it JSON-parses (mirror includeTrailingPartial)
          const trailing = parts[parts.length - 1];
          if (trailing) {
            try {
              JSON.parse(trailing);
              count += 1;
            } catch {
              // genuinely partial — will be consumed when next \n arrives
            }
          }
          preEnterResumeLines = count;
        } else {
          preEnterResumeLines = 0;
        }
      }

      // ① Write prompt to temp file and load into a named tmux buffer.
      //
      // P1-C fix: use a per-session named buffer to prevent concurrent prompt cross-talk.
      // tmux's default paste-buffer uses the most recently added automatic buffer across
      // ALL sessions in the server — two concurrent injectPrompt calls would race: A's
      // load-buffer is overwritten by B's load-buffer before A's paste-buffer executes,
      // causing A to paste B's prompt. Named buffers (-b flag) are per-name and isolated.
      const tmpDir = await mkdtemp(join(tmpdir(), 'f230-prompt-'));
      const promptFile = join(tmpDir, 'prompt.txt');
      // Session name is unique per PtyDriver instance (generateSessionName prefix+random token).
      const bufferName = `f230-${this.sessionName}`;
      try {
        await writeFile(promptFile, text, 'utf8');
        // P2-temp-files fix: delete temp dir in finally so plaintext prompt does not persist
        // on disk. tmux only needs the file to load it into its in-memory buffer; once
        // load-buffer returns the file can be removed safely.
        await tmux('load-buffer', '-b', bufferName, promptFile);
      } finally {
        await rm(tmpDir, { recursive: true, force: true }).catch(() => void 0);
      }
      // Bracketed paste into the pane using the session-scoped named buffer
      await tmux('paste-buffer', '-b', bufferName, '-p', '-t', this.sessionName);
      // Clean up the named buffer immediately after paste to avoid tmux buffer accumulation
      await tmux('delete-buffer', '-b', bufferName).catch(() => void 0);

      // ② Grace sleep: let TUI digest the paste
      const graceSec = Math.max(2, text.length / 15_000);
      await sleep(graceSec * 1000);

      // ③ Snapshot + Send Enter (two-stage: paste + Enter are separate).
      //
      // Snapshot MUST be taken right before Enter (not earlier) so that any files
      // created during the paste grace period are captured as "existing" and excluded
      // from the new-file detection in watchForTranscriptFile.
      //
      // `--session-id` removed (R10): flag writes ai-title only; real events go to a
      // different UUID. PtyDriver watches via watchForTranscriptFile (spike E5: p50=0.11s).
      const existingFiles = snapshotTranscriptFiles(transcriptDir);
      await tmux('send-keys', '-t', this.sessionName, '', 'Enter');

      // P1-B fix: resume mode — transcript path is deterministic.
      // `--resume <sessionId>` appends to an EXISTING <sessionId>.jsonl rather than
      // creating a new file. watchForTranscriptFile only detects NEW files, so it
      // would time out 100% of the time for resume. Return the known path directly.
      //
      // initialLines was computed BEFORE paste+Enter (P1-D fix above) so it only
      // counts lines from the previous turn — not any new lines Claude writes after
      // receiving this turn's Enter.
      if (this.opts.resumeSessionId) {
        const sessionId = this.opts.resumeSessionId;
        const transcriptPath = join(transcriptDir, `${sessionId}.jsonl`);
        const initialLines = preEnterResumeLines ?? 0;

        log.debug(
          { sessionId, transcriptPath, initialLines },
          'resume: returning known transcript path with line offset',
        );
        return { transcriptPath, sessionId, initialLines };
      }

      // B-hook: skip transcript ack — session_id comes from hook sidecar events.
      // Claude 2.1.172+ interactive TUI no longer writes transcript files, so
      // watchForTranscriptFile would always timeout. The carrier's
      // extractSessionIdFromHookEntries handles sessionId discovery.
      if (this.opts.skipTranscriptAck) {
        log.debug('skipTranscriptAck: returning without waiting for transcript file');
        return { transcriptPath: '', sessionId: '' };
      }

      // ④ Watch for the new .jsonl transcript file (first file not in the pre-Enter snapshot).
      // Claude writes the transcript when the first prompt is processed (spike E5: p50=0.11s).
      const transcriptPath = await watchForTranscriptFile(transcriptDir, existingFiles, 5_000);
      const sessionId = basename(transcriptPath).replace('.jsonl', '');

      log.debug({ sessionId, transcriptPath }, 'prompt injected, transcript ack');
      return { transcriptPath, sessionId };
    } finally {
      releaseDir();
    }
  }

  /**
   * Interrupt mid-stream generation.
   * Sends Escape (TUI native interrupt key — E5 Task 1 result).
   * After ESC, transcript gets "[Request interrupted by user]" user event.
   * Session remains alive for resume.
   */
  async cancel(): Promise<void> {
    if (!this.sessionName || this.disposed) return;
    log.debug({ sessionName: this.sessionName }, 'cancelling (ESC)');
    await tmux('send-keys', '-t', this.sessionName, 'Escape');
  }

  /**
   * Kill tmux session. Idempotent — safe to call multiple times.
   * D1: kill-session 防僵尸 (LL-056). Resolves without error if session is gone.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (!this.sessionName) return;

    log.debug({ sessionName: this.sessionName }, 'disposing PTY session');
    try {
      await tmux('kill-session', '-t', this.sessionName);
    } catch {
      // Session already gone — idempotent
    }
  }
}
