/**
 * F230 PTY utility helpers — shared by PtyDriver and ClaudeInteractivePtyCarrierService.
 * Functions here are stateless or use tmux/fs primitives only.
 */
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, watch } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { PtyDriverOptions } from './PtyDriver.js';

const execFileAsync = promisify(execFile);

/**
 * Derives a compact session name from a random token.
 * Keep ≤20 chars: tmux has no hard limit but long names are ugly in `tmux ls`.
 */
export function generateSessionName(prefix: string): string {
  const token = Math.random().toString(36).slice(2, 10); // 8 hex-ish chars
  return `${prefix}-${token}`;
}

/**
 * Shell-quote a single argument for use in a $SHELL -c command string.
 * tmux new-session passes the shell-command arg to $SHELL -c, so every
 * token must be single-quoted to prevent metacharacter injection from
 * caller-supplied values (e.g. model override strings, extra args).
 */
export function shellQuoteArg(s: string): string {
  // Wrap in single quotes; escape embedded single quotes as '\''
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Build the shell command string to launch claude inside the tmux pane.
 *
 * Handles null values from opts.env as `-u KEY` (unset) flags.
 * String values are passed via `tmux new-session -e KEY=VALUE` in start() instead
 * (avoids shell quoting issues — tmux receives them as direct args).
 *
 * Note 3: always unset CLAUDE_CODE_ENTRYPOINT / CLAUDECODE (双保险:
 * even if the caller already deleted them, tmux server env may carry them).
 */
export function buildClaudeCommand(opts: PtyDriverOptions): string {
  const binary = opts.claudeBinary ?? 'claude';
  const args: string[] = [];

  if (opts.resumeSessionId) {
    args.push('--resume', opts.resumeSessionId);
  }
  if (opts.extraArgs?.length) {
    args.push(...opts.extraArgs);
  }

  // P1 shell-quote fix: tmux new-session passes the shell-command arg to
  // $SHELL -c — every token must be quoted to prevent metacharacter injection
  // from caller-supplied values (model override, extraArgs, etc.).
  const claudeCmd = [binary, ...args].map(shellQuoteArg).join(' ');

  // Build -u flags for every null/undefined var in opts.env delta
  const unsetFlags = Object.entries(opts.env)
    .filter(([, v]) => v === null || v === undefined)
    .map(([k]) => `-u ${k}`)
    .join(' ');

  return unsetFlags ? `env ${unsetFlags} ${claudeCmd}` : claudeCmd;
}

/** Run a tmux command, returning stdout. Throws on non-zero exit. */
export async function tmux(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('tmux', args, { encoding: 'utf8' });
  return stdout;
}

/** Run a tmux command synchronously for simple checks. Returns stdout or '' on error. */
export function tmuxSync(...args: string[]): string {
  try {
    return execFileSync('tmux', args, { encoding: 'utf8', timeout: 5000 });
  } catch {
    return '';
  }
}

/**
 * Take a snapshot of existing .jsonl filenames in transcriptDir.
 * Returns an empty Set if the directory doesn't exist yet.
 *
 * Call this immediately before `send-keys Enter` so that
 * watchForTranscriptFile can distinguish pre-existing files from newly-created ones.
 */
export function snapshotTranscriptFiles(transcriptDir: string): Set<string> {
  try {
    return new Set(readdirSync(transcriptDir).filter((f) => f.endsWith('.jsonl')));
  } catch {
    return new Set(); // dir doesn't exist yet — fine, no files to exclude
  }
}

/**
 * Watch for a new .jsonl transcript file to appear in transcriptDir.
 *
 * Background: `claude --session-id <uuid>` writes session metadata (ai-title) to
 * <uuid>.jsonl but routes conversation events to a DIFFERENT file with a
 * Claude-generated UUID. PtyDriver therefore does NOT use `--session-id`, and
 * instead detects the real transcript by watching for any new .jsonl that appears
 * after the prompt Enter key is sent.
 *
 * Algorithm:
 *   1. existingFiles — snapshot from snapshotTranscriptFiles() taken right before Enter
 *   2. Watch for any new .jsonl that is NOT an ai-title-only metadata file
 *   3. ai-title-only files are tracked separately; they resolve the watcher if they
 *      grow beyond one line (i.e., conversation events are appended to the same file)
 *   4. Resolve with the full path of the first qualifying file
 *   5. Reject after timeoutMs
 *
 * Evidence (F230 R10 / R11 root-cause analysis 2026-06-11):
 *   - With --session-id: the given UUID file = {"type":"ai-title",...} (1 line only);
 *     real conversation → different UUID file (mode/user/assistant events)
 *   - Without --session-id: same pattern — Claude still writes ai-title to its own
 *     UUID file first, then routes conversation events to a different file.
 *   - The ai-title file appears p50=0.11s after Enter; the conversation file follows.
 *   - Skipping ai-title-only files prevents premature resolution on the metadata file.
 *   - aiTitleOnlyFiles map also watches tracked files for growth (covers the case
 *     where conversation events ARE appended to the same file in future Claude versions).
 *
 * B-min limitation: concurrent invocations sharing the same transcriptDir can race
 * to claim the same transcript file. For B-min, callers should use unique
 * workingDirectory values when parallel invocations are needed. Phase C will add a
 * per-dir coordination mechanism.
 *
 * @param transcriptDir - directory to watch (may not exist yet)
 * @param existingFiles - set of .jsonl basenames present before Enter was sent
 * @param timeoutMs - max time to wait for a new file to appear
 */
export function watchForTranscriptFile(
  transcriptDir: string,
  existingFiles: Set<string>,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let watcher: ReturnType<typeof watch> | undefined;
    let pollInterval: ReturnType<typeof setInterval>;
    let timer: ReturnType<typeof setTimeout>;
    // Track ai-title-only files: Claude writes a metadata file (ai-title) first,
    // then either appends conversation events to it or creates a separate file.
    // We defer resolution until the file grows or a new non-ai-title file appears.
    const aiTitleOnlyFiles = new Map<string, string>(); // basename → fullPath

    const cleanup = () => {
      clearInterval(pollInterval);
      clearTimeout(timer);
      watcher?.close();
    };

    /**
     * Returns true iff the file contains ONLY a single {"type":"ai-title",...} line.
     *
     * P2 fix (cloud review): also returns true for empty or partially-written files.
     * Claude may open the .jsonl fd before flushing the first JSON line (empty file)
     * or the write may be mid-flight (partial JSON, JSON.parse throws). In both cases
     * the file is NOT a real transcript yet — treat as "defer" (same as ai-title-only)
     * so we keep watching rather than resolving immediately with a wrong path.
     *
     * The re-check loop in checkDir() will resolve when the file grows into a real
     * conversation transcript (or into a complete ai-title-only file that later gets
     * conversation events appended).
     */
    const isAiTitleOnly = (fullPath: string): boolean => {
      try {
        const content = readFileSync(fullPath, 'utf8');
        const lines = content.split('\n').filter(Boolean);
        if (lines.length === 0) return true; // empty file — defer, not a real transcript yet
        if (lines.length !== 1) return false; // multiple lines — real transcript
        const event = JSON.parse(lines[0]);
        return event.type === 'ai-title';
      } catch {
        return true; // partial/unreadable — defer, not a real transcript yet
      }
    };

    const checkDir = () => {
      try {
        const files = readdirSync(transcriptDir).filter((f) => f.endsWith('.jsonl'));

        // Re-check previously-skipped ai-title-only files: if Claude appended
        // conversation events to the same file, it now has more than one line.
        for (const [, fullPath] of aiTitleOnlyFiles) {
          if (!isAiTitleOnly(fullPath)) {
            cleanup();
            resolve(fullPath);
            return;
          }
        }

        // Check for newly created files not yet seen
        for (const file of files) {
          if (existingFiles.has(file) || aiTitleOnlyFiles.has(file)) continue;
          const fullPath = join(transcriptDir, file);
          if (isAiTitleOnly(fullPath)) {
            // Metadata-only file — defer: track for growth and keep watching
            aiTitleOnlyFiles.set(file, fullPath);
          } else {
            // Real conversation transcript (has non-ai-title content or is unreadable)
            cleanup();
            resolve(fullPath);
            return;
          }
        }
      } catch {
        // dir doesn't exist yet — polling will retry
      }
    };

    // fs.watch on the directory (fast notification)
    try {
      if (existsSync(transcriptDir)) {
        watcher = watch(transcriptDir, { persistent: false }, () => checkDir());
        watcher.on('error', () => {
          // ignore watch errors — polling covers it
        });
      }
    } catch {
      // fs.watch may fail on some platforms — polling covers it
    }

    // Polling fallback every 200ms (covers the case where the dir doesn't exist yet)
    pollInterval = setInterval(checkDir, 200);

    timer = setTimeout(() => {
      cleanup();
      reject(new Error(`PtyDriver: no new transcript file appeared within ${timeoutMs}ms in ${transcriptDir}`));
    }, timeoutMs);

    // Initial check in case a file already appeared before we set up the watcher
    checkDir();
  });
}

/**
 * Detect the `--permission-mode bypassPermissions` confirmation screen in tmux pane content.
 *
 * Claude TUI (2.1.170+) shows a confirmation menu when `--permission-mode bypassPermissions`
 * is passed on a fresh machine (consent has not been pre-accepted). The menu looks like:
 *
 *   ❯ 1. No, exit
 *     2. Yes, I accept
 *
 * The DEFAULT cursor is on "1. No, exit" — plain Enter exits the session.
 * To accept: send Down (navigate to "2. Yes, I accept"), then Enter.
 *
 * On machines where consent was already accepted (pre-warmed), this screen does not
 * appear — Claude loads the TUI directly.
 *
 * Detection: presence of the literal string "bypassPermissions" in the pane content
 * (specific enough not to fire on regular chat output).
 *
 * Evidence (砚砚 R3 pane capture 2026-06-10, Claude Code 2.1.170):
 *   - default cursor on "❯ 1. No, exit"
 *   - plain Enter → exits session (selects No)
 *   - "2" + Enter → also exits (numeric input not accepted)
 *   - Down + Enter → navigates to "2. Yes, I accept" → accepted (correct path)
 */
export function isBypassConfirmationScreen(paneContent: string): boolean {
  return paneContent.includes('bypassPermissions');
}

/**
 * Compute the Claude transcript directory for a given cwd.
 *
 * Claude writes conversation transcripts to `~/.claude/projects/<slug>/`
 * where the slug is derived directly from the process cwd by replacing
 * path separators with `-`.
 *
 * F230 diagnostic (2026-06-11): confirmed that Claude uses the ACTUAL CWD slug,
 * not the git-common-dir parent. An earlier hypothesis (resolveGitProjectDir)
 * was incorrect — conversation events appear in the cwd-derived directory.
 *
 * @param effectiveHome — the HOME used by the child Claude process. Pass
 *   `options.accountEnv.HOME` when it is set so that account-isolated
 *   invocations (which run Claude with a different HOME via tmux -e HOME=...)
 *   look for transcripts in the correct directory.
 *   Falls back to `os.homedir()` (API-process HOME) when not provided.
 */
export function ptyTranscriptDir(cwd: string, effectiveHome?: string): string {
  const slug = cwd.replace(/\//g, '-');
  return join(effectiveHome ?? homedir(), '.claude', 'projects', slug);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Serialize concurrent `injectPrompt` calls on the same transcript directory.
 *
 * `watchForTranscriptFile` claims the first new `.jsonl` that appears after Enter.
 * Two concurrent invocations watching the same directory would race — each could
 * claim the other's file, producing wrong session IDs and lost responses.
 *
 * This queue serializes access: the second caller AWAITS the first's release before
 * proceeding with any tmux operations. Both callers complete in order; the second
 * does not paste or send Enter until the first has identified its transcript.
 *
 * Trade-off: same-cwd parallel PTY invocations run sequentially
 * (wall-clock ≈ A + B) instead of concurrently (max(A, B)).
 * For true parallel performance, use unique `workingDirectory` values per invocation.
 *
 * Call before the first `await tmux(...)` in `injectPrompt`. Returns a release
 * function to call in a `finally` block.
 */
const _watchDirQueue = new Map<string, Promise<void>>();

export async function acquireTranscriptDirWatch(dir: string): Promise<() => void> {
  const prev = _watchDirQueue.get(dir) ?? Promise.resolve();

  let release!: () => void;
  const slot = new Promise<void>((resolve) => {
    release = resolve;
  });

  // Chain: after `prev` resolves, block until `slot` resolves (this invocation's turn ends)
  const tail = prev.then(() => slot);
  _watchDirQueue.set(dir, tail);

  // Wait for all prior holders to finish
  await prev;

  // This invocation now holds the dir; return a release function
  return () => {
    release();
    // Remove the map entry when no new waiter has chained onto us (tail is still current)
    if (_watchDirQueue.get(dir) === tail) {
      _watchDirQueue.delete(dir);
    }
  };
}
