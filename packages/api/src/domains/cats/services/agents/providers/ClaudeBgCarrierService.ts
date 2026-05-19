/**
 * F198 Phase B: ClaudeBgCarrierService
 *
 * Carrier that invokes Claude Code via `claude --bg` (Anthropic Agent View
 * daemon mode, available since v2.1.139).
 *
 * Goals vs the legacy `claude -p` ClaudeAgentService:
 *   - Avoid the `-p` flag → claude binary no longer self-sets
 *     CLAUDE_CODE_ENTRYPOINT=sdk-cli (KD-9 + spike empirically confirmed)
 *   - Consume jsonl event stream from ~/.claude/jobs/<short>/ instead of
 *     stdout NDJSON
 *   - 客户端层证据指向走订阅 quota；服务端 billing 仍 pending 6/15 dashboard
 *     / Anthropic dev support confirm
 *
 * Initial production cut — minimal AgentService implementation. Image hints,
 * accountEnv overrides, MCP injection, session resume, OTel spans, etc are
 * intentionally deferred to the integration step that wires this service into
 * the existing routing layer. Spec section: F198 Phase B (KD-10).
 *
 * 砚砚 review guards integrated:
 *   1. state==='error' → yields type='error' then type='done' AgentMessage
 *      (does NOT throw — invoke-single-cat would convert iterator throw into
 *      duplicate error+done events)
 *   2. child.on('error') → reject promise (ENOENT / spawn failure)
 *   3. JobEventConsumer parses jsonl per-line with try/catch (delegated)
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { type CatId, createCatId } from '@cat-cafe/shared';
import { getCatModel } from '../../../../../config/cat-models.js';
import { resolveCliCommandOrBare } from '../../../../../utils/cli-resolve.js';
import { buildChildEnv } from '../../../../../utils/cli-spawn.js';
import type { AgentMessage, AgentService, AgentServiceOptions } from '../../types.js';
import {
  accumulateUsageFromEntries,
  createUsageAccumulator,
  finalizeTranscriptUsage,
  transcriptEntriesToAgentMessages,
} from './BgTranscriptEventConsumer.js';
import {
  ANTHROPIC_PROFILE_MODE_KEY,
  buildClaudeEnvOverrides,
  resolveClaudeModelSelection,
  resolveDefaultClaudeMcpServerPath,
} from './ClaudeAgentService.js';
import { JobEventConsumer } from './JobEventConsumer.js';
import { compileL0ViaSubprocess } from './l0-compiler.js';
import { TranscriptTailer } from './TranscriptTailer.js';

const SHORT_ID_PATTERN = /backgrounded\s*·\s*([a-f0-9]{8})/;

export class CarrierError extends Error {
  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'CarrierError';
    this.cause = cause;
  }
}

export interface ClaudeBgCarrierServiceOptions {
  catId?: CatId;
  model?: string;
  /** Test seam — replaces the real spawn call. */
  spawnFn?: typeof spawn;
  /** Test seam — override default ~/.claude/jobs base dir. */
  jobsDir?: string;
  /** Test seam — invoke() poll interval (ms). Default 500. */
  pollMs?: number;
  /** Absolute path to MCP server entry (dist/index.js) for --mcp-config.
   *  Resolved from env CAT_CAFE_MCP_SERVER_PATH or repo layout heuristics
   *  via `resolveDefaultClaudeMcpServerPath` when undefined.
   *  砚砚 Step-3 P1 (2026-05-14): mirrors ClaudeAgentService.mcpServerPath
   *  so canary布偶猫 sessions still expose Clowder AI MCP tools (cat_cafe_*)
   *  under --bg. Without this, AC-B4 / R5 break when canary flips. */
  mcpServerPath?: string;
  /** Test seam — replaces the real L0 compiler subprocess (Task 3a). */
  l0CompilerFn?: typeof compileL0ViaSubprocess;
}

interface StartJobResult {
  shortId: string;
  consumer: JobEventConsumer;
  /**
   * codex round-8 P2: the effective model the spawned job is actually running.
   * May differ from `this.model` when callbackEnv.CAT_CAFE_ANTHROPIC_MODEL_OVERRIDE
   * is set or when api_key routing omits --model and env decides.
   * Caller (invoke) propagates this into metadata for accurate observability.
   */
  effectiveModel: string;
}

/**
 * Service wrapper for invoking Claude via `claude --bg`.
 *
 * F198 KD-10: replaces `-p` mode carrier path for clients that want
 * entrypoint=cli (client-layer evidence for subscription quota routing).
 */
export class ClaudeBgCarrierService implements AgentService {
  readonly catId: CatId;
  private readonly model: string;
  private readonly spawnFn: typeof spawn;
  private readonly jobsDir?: string;
  private readonly pollMs: number;
  private readonly mcpServerPath: string | undefined;
  /** Windows: cached MCP config file path (created once per instance,
   *  reused across invocations to avoid temp file spam). */
  private mcpConfigFilePath: string | undefined;
  /** F203 Phase C: compiles per-cat L0 → file for --system-prompt-file. */
  private readonly l0CompilerFn: typeof compileL0ViaSubprocess;

  constructor(options?: ClaudeBgCarrierServiceOptions) {
    this.catId = options?.catId ?? createCatId('opus');
    this.model = options?.model ?? getCatModel(this.catId as string);
    this.spawnFn = options?.spawnFn ?? spawn;
    this.l0CompilerFn = options?.l0CompilerFn ?? compileL0ViaSubprocess;
    this.jobsDir = options?.jobsDir;
    this.pollMs = options?.pollMs ?? 500;
    // 砚砚 Step-3 P1: resolve MCP server path same way as ClaudeAgentService
    // (single source of truth via `resolveDefaultClaudeMcpServerPath`).
    const configuredPath = options?.mcpServerPath ?? process.env.CAT_CAFE_MCP_SERVER_PATH;
    if (configuredPath && configuredPath.trim().length > 0) {
      this.mcpServerPath = isAbsolute(configuredPath) ? configuredPath : resolve(process.cwd(), configuredPath);
    } else {
      this.mcpServerPath = resolveDefaultClaudeMcpServerPath();
    }
  }

  /**
   * Best-effort `claude stop <shortId>` — fire-and-forget cleanup after
   * abort / timeout / unexpected wait failure. Errors are intentionally
   * swallowed: the caller is already throwing, and we don't want stop()
   * failures to mask the original cause.
   *
   * codex review (PR #1666 round 5) P1.2.
   */
  private bestEffortStop(shortId: string): void {
    try {
      const child = this.spawnFn(resolveCliCommandOrBare('claude'), ['stop', shortId], {
        stdio: 'ignore',
      });
      // Detach so stop() doesn't keep the event loop alive
      child.unref?.();
      child.on('error', () => {
        /* swallow — best effort */
      });
    } catch {
      /* swallow — best effort */
    }
  }

  /** F203 Phase C — this service injects L0 via `--system-prompt-file` (Task 3). */
  injectsL0Natively(): boolean {
    return true;
  }

  /**
   * F203 Phase C: compile per-cat L0 → temp file for `--system-prompt-file`
   * (compression-immune native system role; replaces the user-message prepend
   * stripped in Task 2). fail-closed: a missing L0 = a cat with no identity/
   * 家规, strictly worse than a failed invocation, so compile failure throws
   * loudly. Per-invocation temp file (not reused), left for OS tmp reclamation
   * — deleting it risks racing the daemon which may read it lazily on resume
   * (mirrors the per-instance mcp-config temp-file pattern, also not cleaned).
   * @returns absolute path to the written L0 file.
   */
  private async compileL0ToTempFile(): Promise<string> {
    const l0Dir = mkdtempSync(join(tmpdir(), 'cat-cafe-l0-'));
    const l0Path = join(l0Dir, 'system-prompt-l0.md');
    try {
      await this.l0CompilerFn({ catId: this.catId as string, outPath: l0Path });
    } catch (err) {
      throw new CarrierError(`L0 compile failed for ${this.catId as string}: ${(err as Error).message}`, err);
    }
    return l0Path;
  }

  /**
   * Launch a `claude --bg <prompt>` background job and resolve once the
   * daemon supervisor has acknowledged the dispatch with a short id.
   *
   * 砚砚 guard #2: child.on('error') ensures ENOENT / EACCES / spawn failures
   * reject instead of hanging.
   */
  async startJob(prompt: string, options?: AgentServiceOptions): Promise<StartJobResult> {
    const l0Path = await this.compileL0ToTempFile();
    return new Promise<StartJobResult>((resolve, reject) => {
      // Critical: even with --bg, the child inherits parent env unless we
      // explicitly strip CLAUDE_CODE_ENTRYPOINT. Otherwise transcript entrypoint
      // becomes sdk-cli regardless of flag. See F198 spike commit 8c5da78c7.
      //
      // F198 refactor (CVO directive 2026-05-14): delegate env construction
      // to the shared `buildClaudeEnvOverrides` helper (exported from
      // ClaudeAgentService) instead of re-implementing 80% of subscription/
      // ENTRYPOINT/Anthropic-clearing rules. Coordinate-system fix for the
      // round-6 补锅 pattern — single source of truth for Claude carrier env.
      //
      // Default to subscription mode unless caller explicitly sets mode in
      // callbackEnv. accountEnv applied LAST (F171). Entrypoint guard FINAL
      // (AC-B6 invariant — never accept ENTRYPOINT poisoning via either env).
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
      envOverrides.CLAUDE_CODE_ENTRYPOINT = null;
      envOverrides.CLAUDECODE = null;
      const env = buildChildEnv(envOverrides);

      // F198 codex round-7 B-prime refactor: model selection delegates to
      // ClaudeAgentService.resolveClaudeModelSelection so we don't drift
      // from production --model handling. Resolves:
      // - callbackEnv MODEL_OVERRIDE_KEY (per-invocation override)
      // - api_key + non-Anthropic model → omit --model (let env drive)
      const { effectiveModel, useEnvModelOverride } = resolveClaudeModelSelection(options?.callbackEnv, this.model);
      const args = useEnvModelOverride ? ['--bg', prompt] : ['--bg', prompt, '--model', effectiveModel];
      // F203 Phase C: native system role from compiled L0 file (above).
      args.push('--system-prompt-file', l0Path);

      // 砚砚 Step-3 P1 (2026-05-14): inject --mcp-config when callbackEnv
      // present + mcpServerPath resolved. Mirrors ClaudeAgentService so
      // canary布偶猫 sessions retain Clowder AI MCP tools (cat_cafe_*) under
      // --bg. Without this, AC-B4 / R5 break the moment canary flips.
      //
      // Windows: claude CLI treats inline JSON as a file path → write JSON
      // to a temp file. POSIX: pass JSON inline (matches ClaudeAgentService).
      if (options?.callbackEnv && this.mcpServerPath) {
        const IS_WINDOWS = process.platform === 'win32';
        if (IS_WINDOWS) {
          if (!this.mcpConfigFilePath || !existsSync(this.mcpConfigFilePath)) {
            const dir = mkdtempSync(join(tmpdir(), 'cat-cafe-bg-mcp-'));
            this.mcpConfigFilePath = join(dir, 'mcp-config.json');
            writeFileSync(
              this.mcpConfigFilePath,
              JSON.stringify({
                mcpServers: { 'cat-cafe': { command: 'node', args: [this.mcpServerPath] } },
              }),
              'utf-8',
            );
          }
          args.push('--mcp-config', this.mcpConfigFilePath);
        } else {
          args.push(
            '--mcp-config',
            JSON.stringify({
              mcpServers: { 'cat-cafe': { command: 'node', args: [this.mcpServerPath] } },
            }),
          );
        }
        // F198 Step-4 (2026-05-14, alpha-evidence): daemon `--bg` discovers
        // cwd `.mcp.json` walking up the tree. WITHOUT this flag, claude
        // would LOAD discovered servers ALONGSIDE our injected cat-cafe MCP
        // → unpredictable tool surface for canary布偶猫 sessions. WITH it,
        // only our explicit --mcp-config is used at runtime.
        //
        // NOTE: this flag does NOT bypass the `.mcp.json` approval UX gate
        // that daemon mode enforces. That gate is one-time-per-project
        // operator setup: first invocation in a new project requires
        // `claude attach <shortId>` → approve servers once → future jobs
        // proceed without prompt. Document as canary deploy step, not
        // code bug. Verified empirically against cat-cafe-alpha worktree.
        args.push('--strict-mcp-config');
      }

      // codex review (PR #1666 round 4) P1: resolve claude binary so hosts
      // with claude installed-but-not-on-PATH (production runtime envs
      // launched via systemd/pm2/launchd) don't fail with ENOENT. Matches
      // existing ClaudeAgentService pattern (utils/cli-resolve.ts).
      const claudeCommand = resolveCliCommandOrBare('claude');

      // codex round 6 P1.3: propagate AbortSignal into spawn so cancellation
      // during the 5-15s startup window kills the child via SIGTERM. Without
      // this, abort during startJob() never reaches waitForTerminal()'s
      // bestEffortStop cleanup path and leaks the daemon job.
      const child = this.spawnFn(claudeCommand, args, {
        cwd: options?.workingDirectory ?? process.cwd(),
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        signal: options?.signal,
      });

      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (err: unknown, result?: StartJobResult) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else if (result) resolve(result);
      };

      child.on('error', (err) => {
        finish(new CarrierError(`claude --bg spawn failed: ${(err as Error).message}`, err));
      });
      child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));

      child.on('close', (code) => {
        if (code !== 0) {
          return finish(new CarrierError(`claude --bg exited code=${code}: ${stderr.slice(0, 300)}`));
        }
        const match = SHORT_ID_PATTERN.exec(stdout);
        if (!match) {
          return finish(new CarrierError(`Could not parse short id from claude --bg stdout: ${stdout.slice(0, 300)}`));
        }
        const shortId = match[1];
        finish(null, {
          shortId,
          consumer: new JobEventConsumer(shortId, { jobsDir: this.jobsDir }),
          effectiveModel,
        });
      });
    });
  }

  /**
   * AgentService contract: invoke and stream back AgentMessages.
   *
   * Step 2 (slice 2): file-tail `state.linkScanPath` transcript jsonl as
   * the daemon writes it; feed new entries to `transcriptEntriesToAgentMessages`
   * for per-message streaming (R2 Hub observability — see砚砚 cross-cat
   * Design Gate 2026-05-14). Lifecycle (session_init + done) emitted by
   * this method once each (砚砚 P1.1).
   *
   * Backward compat: if `linkScanPath` never appears (test fixtures, broken
   * daemon, very short prompts that finish before transcript materializes),
   * fall back to surfacing `state.output.result` as a single text + done.
   *
   * 砚砚 guard #1: state==='error' → emits type='error' AgentMessage then
   * type='done' with metadata.diagnostics.terminalState='error' (does NOT
   * throw — invoke-single-cat catches iterator throws and would convert
   * them into duplicate error+done events). Pattern matches existing
   * ClaudeAgentService isCliError branch.
   */
  async *invoke(prompt: string, options?: AgentServiceOptions): AsyncIterable<AgentMessage> {
    const startedAt = Date.now();
    // codex round-8 P2: receive effective model from startJob so metadata
    // reflects what was actually spawned (not this.model fallback when
    // callbackEnv MODEL_OVERRIDE_KEY or api_key env routing changes the run).
    const { shortId, consumer, effectiveModel } = await this.startJob(prompt, options);

    yield {
      type: 'session_init',
      catId: this.catId,
      sessionId: shortId,
      timestamp: Date.now(),
      metadata: { provider: 'claude-bg', model: effectiveModel },
    };

    // codex review (PR #1666 round 4) P1: honor AbortSignal during polling
    // — otherwise cancellation from invoke-single-cat can't stop our long
    // poll, leaving daemon jobs running and burning resources.
    //
    // codex review (PR #1666 round 5) P1.2: on abort / timeout, issue a
    // best-effort `claude stop <shortId>` so the detached --bg session
    // stops consuming quota instead of leaking until natural completion.
    const timeoutMs = 30 * 60_000;
    const deadline = Date.now() + timeoutMs;

    let tailer: TranscriptTailer | undefined;
    // F198 Phase C (AC-C2): track last emitted detail to deduplicate status messages.
    // Only emit a new 'status' AgentMessage when state.detail actually changes.
    let lastEmittedDetail: string | undefined;
    // cloud codex P2 (2026-05-14): incremental usage accumulator — O(1)
    // scalar state. Avoids retaining every parsed transcript entry until
    // terminal (long jobs would build unbounded memory pressure).
    const usageAcc = createUsageAccumulator();
    let transcriptEntryCount = 0;
    // codex slice-2 P1 round-4 (2026-05-14): track the LAST assistant
    // entry's joined text content. Predicate at terminal:
    //   trim(lastAssistantText) === trim(state.output.result) → suppress
    //   otherwise → emit fallback
    //
    // Why not includes/endsWith: round-3 used `transcriptText.includes(result)`
    // but `"I will verify SPIKE_OK".includes("SPIKE_OK")` falsely matches when
    // result is a substring of EARLIER text — final answer would be silently
    // lost. Strict-equal-on-last-assistant-text is the conservative coordinate:
    // "did the model's FINAL prose turn = output.result". One-off edge cases
    // (multi-text-block last turns where output.result is the concatenation)
    // get a duplicate text rather than silent loss — acceptable tradeoff.
    let lastAssistantText = '';
    const yieldFromTranscript = function* (this: ClaudeBgCarrierService, entries: unknown[]): Generator<AgentMessage> {
      for (const raw of entries) {
        if (typeof raw === 'object' && raw !== null) {
          const entry = raw as Record<string, unknown>;
          if (entry.type === 'assistant') {
            // Reset per assistant entry (the LAST entry's content wins).
            const message = entry.message as Record<string, unknown> | undefined;
            const blocks = message?.content;
            const textParts: string[] = [];
            if (Array.isArray(blocks)) {
              for (const block of blocks) {
                if (typeof block !== 'object' || block === null) continue;
                const b = block as Record<string, unknown>;
                if (b.type === 'text' && typeof b.text === 'string') {
                  textParts.push(b.text);
                }
              }
            }
            // Always reset (even to '' when entry has no text blocks — e.g.
            // tool_use-only last entry → no transcript-side final prose).
            lastAssistantText = textParts.join('');
          }
        }
      }
      for (const msg of transcriptEntriesToAgentMessages(entries, { catId: this.catId })) {
        yield msg;
      }
    }.bind(this);

    while (Date.now() < deadline) {
      if (options?.signal?.aborted) {
        this.bestEffortStop(shortId);
        throw new Error(`ClaudeBgCarrierService.invoke: aborted for ${shortId}`);
      }

      const state = await consumer.readState();

      // F198 Phase C (AC-C2): emit 'status' when daemon detail changes (dedup by string equality).
      // 'status' messages do NOT create chat bubbles; frontend routes them to the cat avatar tooltip.
      // Null/empty detail is ignored — only meaningful progress strings are emitted.
      const currentDetail = state?.detail;
      if (currentDetail && currentDetail !== lastEmittedDetail && state?.state !== 'done' && state?.state !== 'error') {
        lastEmittedDetail = currentDetail;
        yield {
          type: 'status',
          catId: this.catId,
          content: currentDetail,
          timestamp: Date.now(),
        };
      }

      // Lazy-init tailer once daemon writes state.linkScanPath. Some short
      // jobs may complete before linkScanPath appears — handled by legacy
      // fallback in the terminal branch below.
      if (!tailer && state?.linkScanPath) {
        tailer = new TranscriptTailer(state.linkScanPath);
      }

      // Stream any new transcript entries.
      // cloud codex round-12 P1 (2026-05-14): wrap tail reads in try/catch
      // — readNew can fail at runtime (linkScanPath unreadable / removed /
      // replaced with directory between polls). On non-terminal failure:
      // bestEffortStop + rethrow (consumer dies, leak guard fires).
      //
      // cloud codex round-15 P1 (2026-05-14): if state is ALREADY terminal
      // when tail read fails, gracefully degrade — output.result fallback
      // is available, throwing would block backward-compat success path.
      // Disable tailer so terminal branch treats this as legacy fallback case.
      if (tailer) {
        let newEntries: unknown[] = [];
        try {
          newEntries = await tailer.readNew();
        } catch (err) {
          if (state?.state === 'done' || state?.state === 'error') {
            // Terminal state — degrade gracefully, fallback path will emit
            // output.result if present. No leak (job already finished).
            tailer = undefined;
          } else {
            // Non-terminal — consumer can't recover, prevent quota leak.
            this.bestEffortStop(shortId);
            throw new Error(
              `ClaudeBgCarrierService.invoke: transcript read failed for ${shortId}: ${(err as Error).message}`,
            );
          }
        }
        if (newEntries.length > 0) {
          accumulateUsageFromEntries(usageAcc, newEntries);
          transcriptEntryCount += newEntries.length;
          yield* yieldFromTranscript(newEntries);
        }
      }

      if (state?.state === 'done' || state?.state === 'error') {
        // Final drain: transcript may have grown between last poll and terminal.
        // codex slice-2 P1 (regression B): use includeTrailingPartial to also
        // emit the final line when daemon committed state=done before
        // flushing the trailing \n on the last entry.
        // cloud codex round-15 P1: we're already in terminal branch here,
        // so a drain failure should degrade to output.result fallback,
        // never throw (job already finished, no leak risk).
        if (tailer) {
          let finalEntries: unknown[] = [];
          try {
            finalEntries = await tailer.readNew({ includeTrailingPartial: true });
          } catch {
            // Degrade gracefully — fallback emit will fire below if
            // output.result is present and transcript lacks matching text.
            tailer = undefined;
          }
          if (finalEntries.length > 0) {
            accumulateUsageFromEntries(usageAcc, finalEntries);
            transcriptEntryCount += finalEntries.length;
            yield* yieldFromTranscript(finalEntries);
          }
        }

        // Fallback (codex slice-2 P1 round-4): emit state.output.result
        // unless trim(lastAssistantText) === trim(output.result). Strict
        // equality on the LAST assistant entry's joined text — substring /
        // endsWith would falsely match when result is a prefix/suffix of
        // earlier text (round-3 SPIKE_OK trap).
        const resultText = state.output?.result;
        if (state.state === 'done' && typeof resultText === 'string' && resultText.trim().length > 0) {
          const transcriptCoversResult = lastAssistantText.trim() === resultText.trim();
          if (!transcriptCoversResult) {
            yield {
              type: 'text',
              catId: this.catId,
              sessionId: shortId,
              content: resultText,
              timestamp: Date.now(),
            };
          }
        }

        // codex review (PR #1666) P1.1: error path emits error + done (NOT throw).
        if (state.state === 'error') {
          yield {
            type: 'error',
            catId: this.catId,
            sessionId: shortId,
            error: state.detail ?? 'claude --bg job ended in error state',
            timestamp: Date.now(),
          };
        }

        const durationMs = Date.now() - startedAt;
        // cloud codex round-13 P2: only attach usage when accumulator has
        // real signal (at least one parsed assistant entry).
        //
        // cloud codex round-16 P2: gate is `assistantTurnCount > 0` ONLY
        // (NOT `tailer && ...`). If streaming observed usage and the
        // terminal drain failed (tailer degraded to undefined via round-15
        // graceful path), we still have valid accumulated usage —
        // discarding it would corrupt cost/usage telemetry on this success.
        const usage = usageAcc.assistantTurnCount > 0 ? finalizeTranscriptUsage(usageAcc, { durationMs }) : undefined;

        yield {
          type: 'done',
          catId: this.catId,
          sessionId: shortId,
          timestamp: Date.now(),
          metadata: {
            provider: 'claude-bg',
            model: effectiveModel,
            ...(usage ? { usage } : {}),
            diagnostics: {
              ...(state.state === 'error' ? { terminalState: 'error' } : {}),
              durationMs,
              // Report transcript entry count when we actually counted any
              // (not gated on tailer being currently defined — see round-16).
              ...(transcriptEntryCount > 0 ? { transcriptEntries: transcriptEntryCount } : {}),
            },
          },
        };
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, this.pollMs));
    }

    // Timeout
    this.bestEffortStop(shortId);
    throw new Error(`ClaudeBgCarrierService.invoke: timeout ${timeoutMs}ms for ${shortId}`);
  }
}
