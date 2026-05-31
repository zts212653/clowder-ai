/**
 * TmuxAgentSpawner — runs CLI agents inside tmux panes with FIFO-based NDJSON streaming.
 *
 * 单源双消费: tmux pane (agent CLI | tee $FIFO)
 *   FIFO → parseNDJSON → yield events (机器侧)
 *   node-pty attach → WebSocket → xterm.js (人类侧, read-only)
 */

import { execFile, execFileSync } from 'node:child_process';
import type { ReadStream } from 'node:fs';
import { closeSync, constants, createReadStream, openSync, statSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Interface as ReadlineInterface } from 'node:readline';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { createModuleLogger } from '../../infrastructure/logger.js';
import { buildCliDiagnostics } from '../../utils/cli-diagnostics.js';
import { maybeCollectStreamError } from '../../utils/cli-spawn.js';
import { resolveCliTimeoutMs } from '../../utils/cli-timeout.js';
import type { CliSpawnOptions } from '../../utils/cli-types.js';
// parseNDJSON not used directly — we create readline inline for killability.
import type { SpawnCliOverride } from '../cats/services/types.js';
import type { AgentPaneRegistry } from './agent-pane-registry.js';
import type { TmuxGateway } from './tmux-gateway.js';

const log = createModuleLogger('tmux-spawner');

const execAsync = promisify(execFile);

/** Default timeout for first valid NDJSON event after pane spawn (30s). */
const DEFAULT_FIRST_EVENT_TIMEOUT_MS = 30_000;

export interface TmuxSpawnOptions extends CliSpawnOptions {
  worktreeId: string;
  invocationId: string;
  /** Override first-event timeout (ms). 0 = disabled. Default: 30s */
  firstEventTimeoutMs?: number;
}

export interface TmuxSpawnResult {
  paneId: string;
}
export interface TmuxSpawnDeps {
  tmuxGateway: TmuxGateway;
}

/** Escape for single-quoted shell: ' → '"'"' */
function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\"'\"'")}'`;
}

/** Build: set -o pipefail; command args | tee $FIFO; echo "EXIT:$?" > $EXIT_FILE */
function buildPaneCommand(
  opts: TmuxSpawnOptions,
  fifoPath: string,
  exitFilePath: string,
  stderrFilePath: string,
  stdinFilePath?: string,
): string {
  const parts = [shellEscape(opts.command), ...opts.args.map(shellEscape)];
  // Incident 2026-05-29 P1 (cloud codex review): codex `-- -` reads the prompt from
  // stdin, but a tmux pane has no stdin pipe. Redirect from a 0600 temp file so the
  // prompt reaches codex (content stays off argv/ps — only the file path is visible).
  const stdinRedirect = stdinFilePath != null ? ` < ${shellEscape(stdinFilePath)}` : '';
  // pipefail ensures $? reflects the CLI exit code, not tee's
  if (opts.outputMode === 'plainText') {
    const stderrFile = shellEscape(stderrFilePath);
    return `set -o pipefail; ${parts.join(' ')}${stdinRedirect} 2> ${stderrFile} | tee ${shellEscape(fifoPath)}; echo "EXIT:$?" > ${shellEscape(exitFilePath)}; cat ${stderrFile} >&2`;
  }
  return `set -o pipefail; ${parts.join(' ')}${stdinRedirect} 2>&1 | tee ${shellEscape(fifoPath)}; echo "EXIT:$?" > ${shellEscape(exitFilePath)}`;
}

/** Read exit code sentinel file with retry (race: FIFO EOF before file write) */
async function readExitCode(path: string, retries = 5): Promise<number | null> {
  const { readFile } = await import('node:fs/promises');
  for (let i = 0; i < retries; i++) {
    try {
      const match = /^EXIT:(\d+)$/.exec((await readFile(path, 'utf-8')).trim());
      if (match) return Number(match[1]);
    } catch {
      /* not yet written */
    }
    if (i < retries - 1) await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

/**
 * Spawn a CLI agent inside a tmux pane and yield NDJSON events via FIFO.
 * Same event format as spawnCli() — callers are agnostic to execution mode.
 */
export async function* spawnCliInTmux(
  options: TmuxSpawnOptions,
  deps: TmuxSpawnDeps,
): AsyncGenerator<unknown, TmuxSpawnResult, undefined> {
  const { tmuxGateway } = deps;
  const idleTimeoutMs = resolveCliTimeoutMs(options.timeoutMs);
  const firstEventTimeoutMs =
    options.firstEventTimeoutMs ??
    (options.outputMode === 'plainText' ? idleTimeoutMs : DEFAULT_FIRST_EVENT_TIMEOUT_MS);

  const tmpDir = await mkdtemp(join(tmpdir(), `catcafe-agent-${options.invocationId}-`));
  const fifoPath = join(tmpDir, 'output.fifo');
  const exitFilePath = join(tmpDir, 'exit-code');
  const stderrFilePath = join(tmpDir, 'stderr.log');
  // Incident 2026-05-29 P1 (cloud codex review): codex `-- -` reads prompt from stdin,
  // but a tmux pane has no stdin pipe. Write stdinInput to a 0600 temp file (inside
  // tmpDir) and redirect it in the pane command (buildPaneCommand). Prompt content
  // stays off argv/ps — only the file path is visible.
  //
  // P1 #2 (same review round): the stdin temp file holds the full conversation history,
  // and the main try/finally that removes tmpDir only starts later. Wrap the entire
  // setup phase so any failure here (mkfifo / createAgentPane / execInPane when tmux is
  // unavailable) still removes tmpDir — otherwise the prompt is left on disk forever.
  let stdinFilePath: string | undefined;
  let paneId: string;
  try {
    if (options.stdinInput != null) {
      const { writeFile } = await import('node:fs/promises');
      stdinFilePath = join(tmpDir, 'stdin');
      await writeFile(stdinFilePath, options.stdinInput, { mode: 0o600 });
    }
    await execAsync('mkfifo', [fifoPath]);

    paneId = await tmuxGateway.createAgentPane(options.worktreeId, {
      ...(options.cwd ? { cwd: options.cwd } : {}),
    });

    // Inject environment variables into pane shell
    if (options.env) {
      for (const [key, value] of Object.entries(options.env)) {
        if (value !== null && value !== undefined) {
          await tmuxGateway.execInPane(options.worktreeId, paneId, `export ${key}=${shellEscape(value)}`);
        }
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    await tmuxGateway.execInPane(
      options.worktreeId,
      paneId,
      buildPaneCommand(options, fifoPath, exitFilePath, stderrFilePath, stdinFilePath),
    );
    // Set read-only AFTER command starts (select-pane -d blocks send-keys if set before)
    await tmuxGateway.setPaneReadOnly(options.worktreeId, paneId, true);
  } catch (setupErr) {
    // Remove tmpDir (incl. the prompt stdin file) before propagating the setup failure.
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    throw setupErr;
  }
  yield { __tmuxPaneCreated: true, paneId, worktreeId: options.worktreeId } as unknown;

  let timedOut = false;
  let killed = false;
  let gotFirstEvent = false;
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  let firstEventTimer: ReturnType<typeof setTimeout> | null = null;
  let stderrPollTimer: ReturnType<typeof setInterval> | null = null;
  let observedStderrSize = 0;
  let observedStderrMtimeMs = 0;
  // CRITICAL: Hold references so killAgent can close readline to unblock `for await`.
  let fifoStream: ReadStream | null = null;
  let rl: ReadlineInterface | null = null;
  // Track floating killAgent() promises from abort/timeout handlers so the finally
  // block can await them — prevents process.exit(0) from failing to terminate in
  // node:test worker processes when FIFO fds are still pending cleanup.
  let killPromise: Promise<void> | null = null;

  const killAgent = async (): Promise<void> => {
    if (killed) return;
    killed = true;
    // Step 1: Close readline FIRST to unblock `for await (rl)` in the generator.
    // This must happen before killing the pane so the generator loop can exit
    // and the caller can consume the __cliTimeout yield.
    if (rl) {
      try {
        rl.close();
      } catch {
        /* best-effort */
      }
    }
    // Step 2: Kill the tmux pane (which is the write end of the FIFO).
    // We must kill the pane BEFORE destroying fifoStream — on macOS/Linux,
    // destroying a ReadStream on a FIFO does not release the fd until the
    // write end is closed. If the tmux process is still writing, the fd
    // stays open and keeps the Node event loop alive.
    const sock = tmuxGateway.socketName(options.worktreeId);
    const bin = tmuxGateway.tmuxBin;
    try {
      execFileSync(bin, ['-L', sock, 'send-keys', '-t', paneId, 'C-c', ''], { stdio: 'ignore' });
    } catch {
      // Pane already dead — skip grace period, go straight to stream cleanup.
      destroyFifoStream();
      return;
    }
    await new Promise((r) => setTimeout(r, 3000));
    try {
      execFileSync(bin, ['-L', sock, 'kill-pane', '-t', paneId], { stdio: 'ignore' });
    } catch {
      /* pane exited during grace period */
    }
    // Step 3: Now that the write end (tmux pane) is dead, destroy the
    // FIFO ReadStream. The fd will release immediately since no writer remains.
    destroyFifoStream();
  };

  /**
   * Destroy fifoStream safely. When killAgent runs before the FIFO's
   * writer (tee in tmux pane) has connected, the underlying fs.open()
   * syscall blocks in the kernel indefinitely, leaving an orphaned
   * FSReqCallback that prevents Node from exiting. Opening the write
   * end with O_WRONLY|O_NONBLOCK unblocks that pending open() so
   * destroy() can complete cleanly.
   */
  const destroyFifoStream = (): void => {
    try {
      const wfd = openSync(fifoPath, constants.O_WRONLY | constants.O_NONBLOCK);
      closeSync(wfd);
    } catch {
      /* FIFO already deleted or no reader — safe to ignore */
    }
    if (fifoStream) {
      try {
        fifoStream.on('error', () => {});
        fifoStream.destroy();
      } catch {
        /* best-effort */
      }
    }
  };

  /** Reset the idle timeout (fires after each valid NDJSON event). */
  const resetIdleTimeout = (): void => {
    if (idleTimeoutMs === 0) return;
    if (timeoutTimer) clearTimeout(timeoutTimer);
    timeoutTimer = setTimeout(() => {
      log.error({ invocationId: options.invocationId, paneId, idleTimeoutMs }, 'Idle timeout fired');
      timedOut = true;
      killPromise ??= killAgent();
      killPromise.catch(() => {});
    }, idleTimeoutMs);
    if (timeoutTimer && typeof timeoutTimer === 'object' && 'unref' in timeoutTimer) {
      timeoutTimer.unref();
    }
  };

  const recordPlainTextActivity = (): void => {
    if (!gotFirstEvent) {
      gotFirstEvent = true;
      if (firstEventTimer) {
        clearTimeout(firstEventTimer);
        firstEventTimer = null;
      }
    }
    resetIdleTimeout();
  };

  const pollStderrActivity = (): void => {
    if (options.outputMode !== 'plainText' || killed) return;
    try {
      const stat = statSync(stderrFilePath);
      const changed = stat.size > observedStderrSize || stat.mtimeMs > observedStderrMtimeMs;
      observedStderrSize = Math.max(observedStderrSize, stat.size);
      observedStderrMtimeMs = Math.max(observedStderrMtimeMs, stat.mtimeMs);
      if (changed && stat.size > 0) recordPlainTextActivity();
    } catch {
      /* stderr file may not exist before the CLI writes its first stderr byte */
    }
  };

  const startPlainTextStderrWatcher = (): void => {
    if (options.outputMode !== 'plainText' || idleTimeoutMs === 0) return;
    const pollMs = Math.max(50, Math.min(250, Math.floor(idleTimeoutMs / 4)));
    stderrPollTimer = setInterval(pollStderrActivity, pollMs);
    if (stderrPollTimer && typeof stderrPollTimer === 'object' && 'unref' in stderrPollTimer) {
      stderrPollTimer.unref();
    }
  };

  /** Start the first-event timeout (pane spawned but no valid NDJSON yet). */
  const startFirstEventTimeout = (): void => {
    if (firstEventTimeoutMs === 0) return;
    firstEventTimer = setTimeout(() => {
      if (gotFirstEvent) return; // Race: event arrived just as timer fired
      log.error(
        { invocationId: options.invocationId, paneId, firstEventTimeoutMs },
        'First event timeout — CLI may have failed to start',
      );
      timedOut = true;
      killPromise ??= killAgent();
      killPromise.catch(() => {});
    }, firstEventTimeoutMs);
    if (firstEventTimer && typeof firstEventTimer === 'object' && 'unref' in firstEventTimer) {
      firstEventTimer.unref();
    }
  };

  startFirstEventTimeout();
  startPlainTextStderrWatcher();

  const abortHandler = (): void => {
    killPromise ??= killAgent();
    killPromise.catch(() => {});
  };
  if (options.signal) {
    if (options.signal.aborted) await killAgent();
    else options.signal.addEventListener('abort', abortHandler, { once: true });
  }

  try {
    if (killed) {
      return { paneId };
    }

    // createReadStream queues open() asynchronously — it doesn't block here.
    // The actual open() blocks at the kernel level until tee connects as writer.
    // killAgent closes the active reader/stream to unblock `for await`.
    fifoStream = createReadStream(fifoPath, { encoding: 'utf-8' });
    const plainTextChunks: string[] = [];
    // F212 (砚砚 round-4 P2): NDJSON mode tmux `2>&1 | tee fifo` merges stderr into stdout fifo.
    // Non-JSON lines (= stderr noise) end up in the parse-error branch and were previously
    // log-and-dropped. Collect a bounded slice here so abnormal-exit / timeout can feed it into
    // buildCliDiagnostics for reasonCode classification. Bounded by line count + total chars to
    // avoid OOM on pathological output. Sanitization happens inside buildCliDiagnostics, not here.
    const nonJsonOutput: string[] = [];
    // F212 Phase D: result error events are valid JSON (never hit nonJsonOutput), so collect
    // them separately for cliDiagnostics — same root-cause fix as cli-spawn maybeCollectStreamError.
    const streamErrorTexts: string[] = [];
    const structuredErrorTexts: string[] = [];
    let nonJsonChars = 0;
    const NON_JSON_MAX_LINES = 30;
    const NON_JSON_MAX_CHARS = 8192;
    try {
      if (options.outputMode === 'plainText') {
        for await (const chunk of fifoStream) {
          const text = chunk.toString();
          plainTextChunks.push(text);
          if (text.length > 0) recordPlainTextActivity();
        }
      } else {
        rl = createInterface({ input: fifoStream, crlfDelay: Infinity });
        for await (const line of rl) {
          const trimmed = line.trim();
          if (trimmed.length === 0) continue;
          let event: unknown;
          try {
            event = JSON.parse(trimmed);
          } catch {
            log.error({ line: trimmed }, 'JSON parse error');
            // F212 (砚砚 round-4): preserve non-JSON line for cliDiagnostics classification.
            if (nonJsonOutput.length < NON_JSON_MAX_LINES && nonJsonChars + trimmed.length <= NON_JSON_MAX_CHARS) {
              nonJsonOutput.push(trimmed);
              nonJsonChars += trimmed.length;
            }
            continue;
          }
          // F212 Phase D: collect result error events (type==='result' && subtype!=='success')
          // for cliDiagnostics — they are valid JSON so they never reach nonJsonOutput above.
          maybeCollectStreamError(event, streamErrorTexts, structuredErrorTexts);
          // Mark first event and switch from first-event timeout to idle timeout.
          if (!gotFirstEvent) {
            gotFirstEvent = true;
            if (firstEventTimer) {
              clearTimeout(firstEventTimer);
              firstEventTimer = null;
            }
          }
          // Reset idle timeout only on valid NDJSON events.
          // Invalid output should not mask a hung CLI.
          resetIdleTimeout();
          yield event;
        }
      }
    } catch (streamErr) {
      // When killAgent() destroys the FIFO stream, the active reader throws
      // ERR_STREAM_PREMATURE_CLOSE or ERR_USE_AFTER_CLOSE. This is expected.
      if (!killed) throw streamErr;
    }

    const exitCode = await readExitCode(exitFilePath);
    // F212 (云端 codex P2): always read stderr file once so abnormal-exit / timeout branches
    // can feed it into buildCliDiagnostics for reasonCode classification. Previously only
    // plainText mode read stderr and other modes built diagnostics from empty rawText.
    let stderrCaptured = '';
    try {
      stderrCaptured = await readFile(stderrFilePath, 'utf-8');
    } catch {
      /* stderr file may be absent if pane startup failed before redirection */
    }
    if (options.outputMode === 'plainText') {
      yield {
        __cliPlainText: true,
        stdout: plainTextChunks.join(''),
        stderr: stderrCaptured,
        exitCode,
        signal: null,
        command: options.command,
      };
    }
    if (!killed && exitCode !== null && exitCode !== 0) {
      // F212 AC-A1: structured diagnostics on tmux abnormal exit.
      // 云端 codex P2 + 砚砚 round-4: NDJSON mode merges stderr→stdout fifo so stderrFile is empty;
      // non-JSON lines collected from parse-error branch (= stderr noise) carry the actual error text.
      // plainText mode has stderrCaptured populated from the independent stderr file redirect.
      const ndjsonNoise = nonJsonOutput.join('\n');
      const rawText = [ndjsonNoise, ...streamErrorTexts, stderrCaptured].filter(Boolean).join('\n');
      const cliDiagnostics = buildCliDiagnostics({
        rawText,
        structuredErrorText: structuredErrorTexts.filter(Boolean).join('\n'),
        debugRef: {
          command: options.command,
          exitCode,
          signal: null,
        },
      });
      yield {
        __cliError: true,
        exitCode,
        signal: null,
        message: `CLI 异常退出 (code: ${exitCode}, tmux pane: ${paneId})`,
        command: options.command,
        cliDiagnostics,
      };
    }
    if (timedOut) {
      // F212 砚砚 round-4: same dual-source merge as abnormal exit branch.
      const ndjsonNoise = nonJsonOutput.join('\n');
      const cliDiagnostics = buildCliDiagnostics({
        rawText: [ndjsonNoise, ...streamErrorTexts, stderrCaptured].filter(Boolean).join('\n'),
        structuredErrorText: structuredErrorTexts.filter(Boolean).join('\n'),
        debugRef: {
          command: options.command,
          exitCode,
          signal: null,
        },
      });
      yield {
        __cliTimeout: true,
        timeoutMs: gotFirstEvent ? idleTimeoutMs : firstEventTimeoutMs,
        message: gotFirstEvent
          ? `CLI 响应超时 (${Math.round(idleTimeoutMs / 1000)}s idle, tmux pane: ${paneId})`
          : `CLI 启动超时 — 未收到首个有效事件 (${Math.round(firstEventTimeoutMs / 1000)}s, tmux pane: ${paneId})`,
        command: options.command,
        cliDiagnostics,
      };
    }
    return { paneId };
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (firstEventTimer) clearTimeout(firstEventTimer);
    if (stderrPollTimer) clearInterval(stderrPollTimer);
    if (options.signal) options.signal.removeEventListener('abort', abortHandler);
    if (killPromise) {
      try {
        await killPromise;
      } catch {
        /* best-effort — killAgent errors are non-fatal */
      }
    }
    if (rl) {
      try {
        rl.close();
      } catch {
        /* best-effort */
      }
      rl = null;
    }
    destroyFifoStream();
    fifoStream = null;
    try {
      await rm(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Create a SpawnCliOverride that routes agent execution through tmux panes.
 * Called per-invocation in invoke-single-cat.ts when tmux is available.
 */
export function createTmuxSpawnOverride(
  worktreeId: string,
  invocationId: string,
  userId: string,
  tmuxGateway: TmuxGateway,
  agentPaneRegistry?: AgentPaneRegistry,
): SpawnCliOverride {
  return async function* tmuxOverride(cliOpts: CliSpawnOptions) {
    await tmuxGateway.ensureServer(worktreeId);
    const gen = spawnCliInTmux({ ...cliOpts, worktreeId, invocationId }, { tmuxGateway });

    let paneId: string | undefined;
    try {
      for (;;) {
        const { value, done } = await gen.next();
        if (done) {
          paneId = (value as TmuxSpawnResult | undefined)?.paneId ?? paneId;
          break;
        }
        // Intercept __tmuxPaneCreated to register with AgentPaneRegistry
        const ev = value as Record<string, unknown>;
        if (ev.__tmuxPaneCreated && typeof ev.paneId === 'string') {
          paneId = ev.paneId;
          agentPaneRegistry?.register(invocationId, worktreeId, paneId, userId);
        }
        yield value;
      }
    } catch (err) {
      agentPaneRegistry?.markCrashed(invocationId, err instanceof Error ? err.message : null);
      throw err;
    }
  };
}
