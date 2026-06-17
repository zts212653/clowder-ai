/**
 * F230 Phase B: ClaudeInteractivePtyCarrierService
 *
 * Carrier that invokes Claude via an interactive PTY session managed by tmux.
 * Backup/alternative to `claude --bg` daemon (F198). Avoids the `-p` flag
 * entirely → billing identity stays `cli` (not `sdk-cli`).
 *
 * Architecture (B-hook):
 *   - PtyDriver handles tmux session lifecycle + prompt injection
 *   - Hook sidechannel: Stop/PostToolUse hooks write structured JSON to sidecar jsonl
 *   - TranscriptTailer reads sidecar (not transcript) for output events
 *   - hookEntriesToAgentMessages transforms hook events to AgentMessages
 *   - Terminal state: Stop hook event + silence fallback
 *   - Cancel: options.signal → driver.cancel() (ESC) → drain → driver.dispose()
 *   - Usage: degraded (hooks carry no token data)
 *
 * F230 KD-1: per-invocation form — each invoke() starts a fresh tmux session
 * and disposes it when done. Resume via `sessionId` option reuses transcript.
 * Persistent session form (Phase C) is out of B-min scope.
 *
 * Note: B-min does NOT inject --system-prompt-file (L0 compiler integration
 * deferred to a later phase) to stay minimal and avoid dependency on
 * compileL0ViaSubprocess machinery.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { type CatId, createCatId } from '@cat-cafe/shared';
import { getCatModel } from '../../../../../config/cat-models.js';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import type { AgentMessage, AgentService, AgentServiceOptions, TokenUsage } from '../../types.js';
import {
  ANTHROPIC_PROFILE_MODE_KEY,
  buildClaudeEnvOverrides,
  resolveClaudeModelSelection,
  resolveDefaultClaudeMcpServerPath,
} from './ClaudeAgentService.js';
import {
  extractEntrypointFromHookEntries,
  extractSessionIdFromHookEntries,
  hookEntriesToAgentMessages,
  isHookTerminalEvent,
} from './HookSidechannelConsumer.js';
import { appendLocalImagePathHints, collectImageAccessDirectories } from './image-cli-bridge.js';
import { extractImagePaths } from './image-paths.js';
import { type HookInfrastructureResult, setupHookInfrastructure } from './pty/hook-setup.js';
import type { PtyDriverOptions } from './pty/PtyDriver.js';
import { PtyDriver } from './pty/PtyDriver.js';
import { ptyTranscriptDir, sleep } from './pty/pty-utils.js';
export { ptyTranscriptDir }; // re-export for consumers (f230-interactive-pty-carrier.test.js)

import { TranscriptTailer } from './TranscriptTailer.js';

const log = createModuleLogger('interactive-pty-carrier');

export interface ClaudeInteractivePtyCarrierServiceOptions {
  catId?: CatId;
  /** Test seam: polling interval for TranscriptTailer (ms). Default 500. */
  pollIntervalMs?: number;
  /** Test seam: terminal timeout (silence fallback, ms). Default 5 min. */
  terminalTimeoutMs?: number;
  /** Test seam: working directory for PtyDriver (default to resolved cwd). */
  cwd?: string;
  /** Test seam: inject a custom PtyDriver factory. Default creates real PtyDriver. */
  driverFactory?: (opts: PtyDriverOptions) => PtyDriver;
  /** Test seam: transcript directory override. */
  transcriptDirOverride?: string;
  /**
   * Absolute path to the MCP server entry point (dist/index.js).
   * Defaults to CAT_CAFE_MCP_SERVER_PATH env var or repo-layout heuristics.
   * Mirrors ClaudeBgCarrierService.mcpServerPath for AC-B3 parity.
   */
  mcpServerPath?: string;
  /** claude binary path override; default: 'claude' from PATH. B-hook works with any version. */
  claudeBinary?: string;
  /** Test seam: pre-created hook sidecar path. Skips setupHookInfrastructure; carrier tails this file directly. */
  hookSidecarPathOverride?: string;
}

/**
 * Carrier for `claude` interactive PTY mode (F230 B-hook).
 * Complements F198 `--bg` daemon; reads hook sidecar jsonl (Stop/PostToolUse events).
 * Reuses: TranscriptTailer (generic jsonl reader), PtyDriver (tmux lifecycle).
 */
export class ClaudeInteractivePtyCarrierService implements AgentService {
  readonly catId: CatId;
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: used via `const { model } = this` destructuring in invoke()
  private readonly model: string;
  private readonly pollIntervalMs: number;
  private readonly terminalTimeoutMs: number;
  private readonly cwd: string;
  private readonly driverFactory: (opts: PtyDriverOptions) => PtyDriver;
  private readonly transcriptDirOverride: string | undefined;
  private readonly mcpServerPath: string | undefined;
  private readonly claudeBinary: string | undefined;
  private readonly hookSidecarPathOverride: string | undefined;
  /** Cached MCP config file path (created once per instance, reused across invocations). */
  private mcpConfigFilePath: string | undefined;

  constructor(options?: ClaudeInteractivePtyCarrierServiceOptions) {
    this.catId = options?.catId ?? createCatId('opus');
    this.model = getCatModel(this.catId) ?? 'claude-opus-4-8';
    this.pollIntervalMs = options?.pollIntervalMs ?? 500;
    this.terminalTimeoutMs = options?.terminalTimeoutMs ?? 5 * 60 * 1_000; // 5 min
    this.cwd = options?.cwd ?? process.cwd();
    this.driverFactory = options?.driverFactory ?? ((opts) => new PtyDriver(opts));
    this.transcriptDirOverride = options?.transcriptDirOverride;

    // Resolve MCP server path (mirrors ClaudeBgCarrierService pattern)
    const configuredPath = options?.mcpServerPath ?? process.env.CAT_CAFE_MCP_SERVER_PATH;
    if (configuredPath) {
      this.mcpServerPath = isAbsolute(configuredPath) ? configuredPath : resolve(process.cwd(), configuredPath);
    } else {
      this.mcpServerPath = resolveDefaultClaudeMcpServerPath();
    }

    this.claudeBinary = options?.claudeBinary;
    this.hookSidecarPathOverride = options?.hookSidecarPathOverride;
  }

  /**
   * Invoke claude via interactive PTY.
   *
   * Lifecycle:
   *   start → injectPrompt → [yield session_init] → tail transcript → [yield text/tool_use/system_info]
   *   → turn_duration terminal signal → [yield done + usage] → dispose
   */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: async generator with cancellation, multiple error paths, and inline polling loop — extracting would worsen readability
  async *invoke(prompt: string, options?: AgentServiceOptions): AsyncIterable<AgentMessage> {
    const { catId, model, pollIntervalMs, terminalTimeoutMs } = this;

    // ─── Env construction (F230 D3 + KD-7: reuse buildClaudeEnvOverrides) ─────
    const callbackEnvWithMode: Record<string, string> = {
      [ANTHROPIC_PROFILE_MODE_KEY]: 'subscription',
      ...(options?.callbackEnv ?? {}),
    };
    const envOverrides = buildClaudeEnvOverrides(callbackEnvWithMode);
    if (options?.accountEnv) {
      for (const [k, v] of Object.entries(options.accountEnv)) {
        envOverrides[k] = v;
      }
    }
    // Hardcoded guard — always unset entrypoint vars (D3 double-safety)
    // These will map to env -u flags in PtyDriver.buildClaudeCommand().
    envOverrides.CLAUDE_CODE_ENTRYPOINT = null;
    envOverrides.CLAUDECODE = null;

    // PtyDriver: string → tmux -e KEY=VALUE; null → env -u. Proxy vars injected below (P2 F230 2026-06-11).
    const envDelta = envOverrides as Record<string, string | null>;
    // P2 proxy: explicitly forward network proxy vars — defeats tmux server env snapshot.
    Object.assign(
      envDelta,
      Object.fromEntries(
        ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy']
          .filter((k) => process.env[k] != null && !(k in envDelta))
          .map((k) => [k, process.env[k]]),
      ),
    );

    // ─── Model + args ──────────────────────────────────────────────────────────
    const { effectiveModel, useEnvModelOverride } = resolveClaudeModelSelection(options?.callbackEnv, model);
    const extraArgs: string[] = [];
    // --permission-mode bypassPermissions (F230 AC-B4, F198 Phase D parity)
    extraArgs.push('--permission-mode', 'bypassPermissions');
    // --model (skip if env-based override)
    if (!useEnvModelOverride) {
      extraArgs.push('--model', effectiveModel);
    }
    // --mcp-config + --strict-mcp-config (F230 AC-B3): gated on callbackEnv (no callback = MCP unusable).
    if (options?.callbackEnv && this.mcpServerPath && existsSync(this.mcpServerPath)) {
      // Write MCP config to temp file (file-based avoids inline JSON shell quoting issues).
      if (!this.mcpConfigFilePath || !existsSync(this.mcpConfigFilePath)) {
        const dir = mkdtempSync(join(tmpdir(), 'cat-cafe-pty-mcp-'));
        this.mcpConfigFilePath = join(dir, 'mcp-config.json');
        writeFileSync(
          this.mcpConfigFilePath,
          JSON.stringify({
            mcpServers: {
              'cat-cafe': { command: 'node', args: [this.mcpServerPath] },
            },
          }),
          'utf-8',
        );
      }
      extraArgs.push('--mcp-config', this.mcpConfigFilePath, '--strict-mcp-config');
    }
    const cwd = options?.workingDirectory ?? this.cwd;
    // R8: use accountEnv.HOME (if set) for transcriptDir derivation instead of API process homedir.
    const effectiveHome = options?.accountEnv?.HOME;
    const transcriptDir = this.transcriptDirOverride ?? ptyTranscriptDir(cwd, effectiveHome);
    // --resume (E4 P1-D): UUID regex + existsSync guards stale cross-carrier IDs (F230 alpha P1 2026-06-11).
    const resumeSessionId =
      options?.sessionId &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(options.sessionId) &&
      existsSync(join(transcriptDir, `${options.sessionId}.jsonl`))
        ? options.sessionId
        : undefined;
    if (!resumeSessionId && options?.sessionId) {
      log.info({ sessionId: options.sessionId, transcriptDir }, 'stale sessionId — fresh session');
    }
    // `--session-id` removed (R10): flag writes ai-title only; real events go to a different UUID. PtyDriver watches via watchForTranscriptFile.

    // ─── Image inputs: extract paths, grant --add-dir, append path hints (F230 P2-image-inputs fix) ──
    const imagePaths = extractImagePaths(options?.contentBlocks, options?.uploadDir);
    const imageAccessDirs = collectImageAccessDirectories(imagePaths);
    const effectivePrompt = appendLocalImagePathHints(prompt, imagePaths);
    for (const dir of imageAccessDirs) {
      extraArgs.push('--add-dir', dir);
    }

    // ─── Hook sidecar setup (F230 B-hook: output face switch) ──────────────────
    let sidecarPath: string;
    let hookInfra: HookInfrastructureResult | undefined;
    if (this.hookSidecarPathOverride) {
      sidecarPath = this.hookSidecarPathOverride;
    } else {
      const sidecarDir = mkdtempSync(join(tmpdir(), 'f230-hook-'));
      sidecarPath = join(sidecarDir, 'hook-events.jsonl');
      hookInfra = await setupHookInfrastructure(cwd, sidecarPath);
      envDelta.CAT_CAFE_HOOK_SIDECAR = sidecarPath;
    }

    // ─── Driver setup ──────────────────────────────────────────────────────────
    const driver = this.driverFactory({
      cwd,
      env: envDelta,
      extraArgs,
      resumeSessionId,
      claudeBinary: this.claudeBinary,
      readyTimeoutMs: 30_000,
      readyGraceMs: 15_000,
      // B-hook: skip transcript ack — session_id comes from hook sidecar events.
      // Required for claude 2.1.172+ where interactive TUI no longer writes transcripts.
      skipTranscriptAck: true,
    });

    // ─── Abort signal wiring ───────────────────────────────────────────────────
    let abortRequested = false;
    const abortListener = async () => {
      abortRequested = true;
      await driver.cancel().catch(() => void 0);
    };
    options?.signal?.addEventListener('abort', abortListener);

    // P2-abort fix: check if signal is already aborted before committing resources.
    // addEventListener('abort') does not fire if the signal was aborted before it was
    // attached; without this check, a pre-aborted signal would let the carrier proceed
    // through start() (30s+ grace) and injectPrompt(), wasting a Claude turn.
    if (options?.signal?.aborted) {
      options.signal.removeEventListener('abort', abortListener);
      // B-hook P1-2 fix: clean up hook infra + sidecar on pre-abort path (outside try/finally)
      await hookInfra?.cleanup().catch(() => void 0);
      if (hookInfra && sidecarPath) {
        try {
          rmSync(dirname(sidecarPath), { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
      }
      yield { type: 'error', catId, error: 'cancelled before start (signal already aborted)', timestamp: Date.now() };
      yield { type: 'done', catId, isFinal: true, timestamp: Date.now() };
      return;
    }

    try {
      // ─── Start + inject ──────────────────────────────────────────────────────
      try {
        await driver.start();
      } catch (err) {
        yield {
          type: 'error',
          catId,
          error: `PtyDriver start failed: ${(err as Error).message}`,
          timestamp: Date.now(),
        };
        yield { type: 'done', catId, isFinal: true, timestamp: Date.now() };
        return;
      }

      // P2-abort-mid fix: re-check abort after start() completes.
      // The abort listener may have fired during start()'s 30 s grace window —
      // in that case abortRequested is now true but the event won't fire again.
      // Without this guard the carrier proceeds to injectPrompt(), wasting a turn.
      if (abortRequested) {
        yield { type: 'error', catId, error: 'cancelled during start', timestamp: Date.now() };
        yield { type: 'done', catId, isFinal: true, timestamp: Date.now() };
        return;
      }

      let sessionId: string;
      try {
        // F230 R10 root-cause fix (2026-06-11): PtyDriver uses watchForTranscriptFile to
        // discover the transcript — Claude generates its own UUID per session. For resume
        // sessions the path is deterministic (resumeSessionId.jsonl). No serialization gate
        // needed — each concurrent invocation operates on Claude's independently-generated UUID.
        // B-hook: transcriptPath/initialLines no longer used for tailing (hook sidecar replaces),
        // but injectPrompt still discovers transcript for sessionId.
        ({ sessionId } = await driver.injectPrompt(effectivePrompt, transcriptDir));
      } catch (err) {
        yield {
          type: 'error',
          catId,
          error: `PtyDriver injectPrompt failed: ${(err as Error).message}`,
          timestamp: Date.now(),
        };
        yield { type: 'done', catId, isFinal: true, timestamp: Date.now() };
        return;
      }

      // ─── session_init (may be deferred for B-hook) ─────────────────────────
      // R2 P1-3 fix: when skipTranscriptAck is true, driver returns empty sessionId.
      // Defer session_init until we extract the real session_id from hook events.
      // Hook events (both Stop and PostToolUse) carry session_id, so session_init
      // is yielded before any content messages — preserving the expected ordering.
      let sessionInitYielded = false;
      if (sessionId) {
        yield { type: 'session_init', catId, sessionId, timestamp: Date.now() };
        sessionInitYielded = true;
      }

      // ─── Tail hook sidecar (F230 B-hook: replaces transcript tailing) ─────────
      // Sidecar is always fresh per invocation (created empty by setupHookInfrastructure).
      const tailer = new TranscriptTailer(sidecarPath, 0);
      let lastActivityMs = Date.now();
      let terminal = false;
      let hookSessionId: string | undefined;
      let hookEntrypoint: string | undefined;

      while (!terminal) {
        if (abortRequested) {
          // Yield deferred session_init before error+done (consumers expect it)
          if (!sessionInitYielded) {
            yield { type: 'session_init', catId, sessionId: hookSessionId || sessionId, timestamp: Date.now() };
          }
          yield { type: 'error', catId, error: 'cancelled by abort signal', timestamp: Date.now() };
          yield { type: 'done', catId, isFinal: true, timestamp: Date.now() };
          return;
        }

        let entries = await tailer.readNew();
        if (entries.length === 0) {
          entries = await tailer.readNew({ includeTrailingPartial: true });
        }
        if (entries.length > 0) {
          lastActivityMs = Date.now();

          // Extract hook session_id and propagate to session_init (R2 P1-3)
          if (!hookSessionId) {
            hookSessionId = extractSessionIdFromHookEntries(entries);
            if (hookSessionId) {
              sessionId = hookSessionId;
              if (!sessionInitYielded) {
                yield { type: 'session_init', catId, sessionId, timestamp: Date.now() };
                sessionInitYielded = true;
              }
            }
          }

          // Extract entrypoint from enriched hook entries (F230 follow-up ①: AC-B1)
          if (!hookEntrypoint) {
            hookEntrypoint = extractEntrypointFromHookEntries(entries);
          }

          // Emit AgentMessages from hook events (Stop→text, PostToolUse→tool_use)
          const messages = hookEntriesToAgentMessages(entries, { catId });
          for (const msg of messages) {
            yield msg;
          }

          // Detect terminal: Stop hook event (replaces turn_duration)
          for (const raw of entries) {
            if (isHookTerminalEvent(raw)) {
              log.debug({ catId, sessionId }, 'terminal event: Stop hook');
              terminal = true;
              break;
            }
          }
        } else {
          if (Date.now() - lastActivityMs > terminalTimeoutMs) {
            log.warn({ catId, sessionId, terminalTimeoutMs }, 'hook sidecar silence timeout, treating as done');
            terminal = true;
          } else {
            await sleep(pollIntervalMs);
          }
        }
      }

      // Fallback: yield session_init if loop ended without finding hookSessionId
      if (!sessionInitYielded) {
        yield { type: 'session_init', catId, sessionId: hookSessionId || sessionId, timestamp: Date.now() };
      }

      // ─── done + usage (degraded: hooks carry no token data) ──────────────────
      const usage: TokenUsage = {};
      yield {
        type: 'done',
        catId,
        isFinal: true,
        timestamp: Date.now(),
        metadata: {
          model: effectiveModel,
          usage,
          provider: 'claude_interactive_pty',
          // F230 follow-up ①: billing identity from hook sidecar (AC-B1)
          ...(hookEntrypoint ? { entrypoint: hookEntrypoint } : {}),
        },
      };
    } finally {
      options?.signal?.removeEventListener('abort', abortListener);
      await driver.dispose();
      await hookInfra?.cleanup().catch(() => void 0);
      // B-hook P2 fix: clean up sidecar temp dir (hookInfra.cleanup only handles settings/script)
      if (hookInfra && sidecarPath) {
        try {
          rmSync(dirname(sidecarPath), { recursive: true, force: true });
        } catch {
          /* best-effort sidecar cleanup */
        }
      }
    }
  }
}
