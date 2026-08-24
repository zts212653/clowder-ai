/**
 * ACP Client — NDJSON-over-stdio transport to an ACP agent process.
 *
 * Manages the lifecycle: spawn → initialize → sessions → prompts → close.
 * Handles both request/response correlation and streaming notifications.
 *
 * This client is used by:
 *   - Phase A experiment scripts (baseline, OQ-6)
 *   - Phase B GeminiAcpAdapter (production)
 */

import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';

import { createModuleLogger } from '../../../../../../infrastructure/logger.js';
import { resolveCliCommandOrBare } from '../../../../../../utils/cli-resolve.js';
import { buildChildEnv } from '../../../../../../utils/cli-spawn.js';
import { resolveWindowsSpawnPlan } from '../../../../../../utils/cli-spawn-win.js';
import { buildUnixSupervisedSpawnPlan } from '../../../../../../utils/cli-supervised-process.js';
import { AcpCwdIdentityTracker } from './acp-cwd-identity.js';
import type {
  AcpAgentRequest,
  AcpContentBlock,
  AcpInitializeResult,
  AcpMcpServer,
  AcpNewSessionResult,
  AcpNotification,
  AcpPermissionRequest,
  AcpPromptResult,
  AcpResponse,
  AcpSessionUpdate,
  AcpStopReason,
} from './types.js';
import { ACP_METHODS } from './types.js';

const log = createModuleLogger('acp-client');

const IS_WINDOWS = process.platform === 'win32';
const KILL_GRACE_MS = 3_000;
export const ACP_PROMPT_TIMEOUT_MARGIN_MS = 60_000;
const MIN_ACP_PROMPT_REQUEST_CEILING_MS = 3_600_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Keep the protocol request inactivity window strictly above the activity
 * budget without exceeding Node's representable timer range.
 */
export function resolveAcpPromptRequestCeilingMs(activityBudgetMs: number): number {
  if (!Number.isSafeInteger(activityBudgetMs) || activityBudgetMs <= 0) {
    throw new RangeError(`ACP prompt activity budget must be a positive safe integer, got ${activityBudgetMs}`);
  }
  const requestCeilingMs = Math.max(MIN_ACP_PROMPT_REQUEST_CEILING_MS, activityBudgetMs + ACP_PROMPT_TIMEOUT_MARGIN_MS);
  if (requestCeilingMs > MAX_TIMER_DELAY_MS) {
    throw new RangeError(
      `ACP prompt timeout policy exceeds Node timer range: activityBudgetMs=${activityBudgetMs}, ` +
        `max=${MAX_TIMER_DELAY_MS - ACP_PROMPT_TIMEOUT_MARGIN_MS}`,
    );
  }
  return requestCeilingMs;
}

// ─── Config ──────────────────────────────────────────────���─────

/** Callback for handling ACP permission requests. Call `respond` with the chosen option. */
export type AcpPermissionHandler = (req: AcpAgentRequest, respond: (result: { optionId: string }) => void) => void;

export interface AcpClientConfig {
  /** CLI command (e.g. 'gemini') */
  command: string;
  /** Startup args (e.g. ['--acp']) */
  args: string[];
  /** Working directory for the ACP process */
  cwd: string;
  /** Extra env vars to pass to the process */
  env?: Record<string, string>;
  /** Inject spawn function for testing */
  spawnFn?: typeof nodeSpawn;
  /** Custom permission request handler. Defaults to auto-approve (allow_once). */
  permissionHandler?: AcpPermissionHandler;
}

export interface AcpSpawnLogFields {
  command: string;
  argCount: number;
  cwd: string;
  pid?: number;
  envKeyCount: number;
}

export function buildAcpSpawnLogFields(input: {
  command: string;
  args: readonly string[];
  cwd: string;
  pid?: number;
  env?: Record<string, string>;
}): AcpSpawnLogFields {
  return {
    command: input.command,
    argCount: input.args.length,
    cwd: input.cwd,
    ...(input.pid !== undefined ? { pid: input.pid } : {}),
    envKeyCount: Object.keys(input.env ?? {}).length,
  };
}

// ─── Errors ──────────────��─────────────────────────────────────

export class AcpProtocolError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(`ACP error ${code}: ${message}`);
    this.name = 'AcpProtocolError';
  }
}

export class AcpTimeoutError extends Error {
  constructor(
    public readonly method: string,
    public readonly timeoutMs: number,
  ) {
    super(`ACP timeout: ${method} did not respond within ${timeoutMs}ms`);
    this.name = 'AcpTimeoutError';
  }
}

export class AcpStreamIdleError extends Error {
  public readonly code = 'STREAM_IDLE_STALL';
  constructor(
    public readonly sessionId: string,
    public readonly idleSinceMs: number,
    public readonly eventCount: number,
    /** #1186: The configured threshold that triggered termination (ms). */
    public readonly configuredIdleStallMs?: number,
  ) {
    super(
      `Stream idle: no events for ${idleSinceMs}ms after ${eventCount} events received` +
        (configuredIdleStallMs != null ? ` (configured threshold: ${configuredIdleStallMs}ms)` : ''),
    );
    this.name = 'AcpStreamIdleError';
  }
}

// ─── Client ─────────────────────���──────────────────────────���───

/** Parsed capacity error detected from ACP process stderr. */
export interface AcpCapacitySignal {
  message: string;
  timestamp: number;
}

const CAPACITY_RE = /MODEL_CAPACITY_EXHAUSTED|No capacity available|status 429.*Retrying/i;

interface PendingAcpRequest {
  resolve: (response: AcpResponse) => void;
  reject: (error: Error) => void;
  refreshTimeout: () => void;
}

export class AcpClient {
  private child: ChildProcess | null = null;
  private rl: ReadlineInterface | null = null;
  private readonly pending = new Map<string, PendingAcpRequest>();
  private readonly notificationListeners: Array<(n: AcpNotification) => void> = [];
  private initResult: AcpInitializeResult | null = null;
  private closed = false;
  private exited = false;
  /** Sessions whose local prompt ended before provider completion was acknowledged. */
  private readonly unquiescedSessionIds = new Set<string>();
  private readonly capacityListeners = new Set<(signal: AcpCapacitySignal) => void>();
  /**
   * #1186 P1: Per-session cancel callbacks — when cancelSession() is called,
   * invoke the registered callback to settle the local prompt stream immediately.
   * Without this, cancel only sends a JSONRPC notification; the pending .next()
   * blocks until the provider cooperates or the idle watchdog fires, leaving
   * the lease pinned for the full TTL.
   */
  private readonly sessionCancelCallbacks = new Map<string, () => void>();
  /**
   * #1186 P1: Track the pending request ID for each session's prompt so that
   * cancelSession() can settle (reject) the underlying sendRequest promise.
   * Without this, the promise + its request timer stay alive after the generator
   * exits, leaving a stale entry in `pending` — a non-multiplexed process
   * could be reused while the old request is unresolved.
   */
  private readonly sessionPromptPendingIds = new Map<string, string>();
  /** Client-level capacity signal — always captured regardless of listeners.
   *  Fallback for delayed stderr arriving after invoke listener is removed. */
  private _recentCapacitySignal: AcpCapacitySignal | null = null;
  /** #1203: Directory identity captured at spawn. */
  private readonly cwdIdentityTracker: AcpCwdIdentityTracker;

  constructor(private readonly config: AcpClientConfig) {
    this.cwdIdentityTracker = new AcpCwdIdentityTracker(this.config.cwd);
  }

  // ── Lifecycle ────────────────────────────────────────────────

  async initialize(): Promise<AcpInitializeResult> {
    const doSpawn = this.config.spawnFn ?? nodeSpawn;

    // Mirror cli-spawn.ts on Windows so ACP agents can bypass npm-global .cmd shims.
    // On macOS GUI apps (Electron), resolve bare command names (e.g. 'gemini') to
    // full paths via resolveCliCommandOrBare, then inject the bin directory into
    // PATH so `#!/usr/bin/env node` shims can find the node interpreter.
    let command = resolveCliCommandOrBare(this.config.command);
    let args = [...this.config.args];
    const childEnv = buildChildEnv(this.config.env, { workingDirectory: this.config.cwd });
    if (!IS_WINDOWS && isAbsolute(command)) {
      const binDir = dirname(command);
      childEnv.PATH = childEnv.PATH ? `${binDir}:${childEnv.PATH}` : binDir;
    }
    // #712: Re-create bootstrap CWD if it was cleaned up by OS temp-dir rotation
    // or by the ACP agent process on exit. Node.js spawn() returns ENOENT when the
    // cwd doesn't exist, even though the command binary itself exists — the error
    // message misleadingly points at the command path.
    // Skip when a test spawnFn is injected — the directory may be a fake path
    // (e.g. '/my/project') that can't be created on CI runners.
    if (!this.config.spawnFn) {
      mkdirSync(this.config.cwd, { recursive: true, mode: 0o700 });
    }
    // #1203: Capture the cwd's directory identity at spawn so isCwdIntact can
    // detect delete→recreate at the same path, not just deletion.
    this.cwdIdentityTracker.capture();

    const spawnOpts: SpawnOptions & { stdio: ['pipe', 'pipe', 'pipe'] } = {
      cwd: this.config.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv,
    };
    if (IS_WINDOWS && !this.config.spawnFn) {
      const spawnPlan = resolveWindowsSpawnPlan(command, args);
      log.debug(
        {
          original: command,
          resolved: spawnPlan.command,
          mode: spawnPlan.mode,
          shell: spawnPlan.shell,
        },
        'ACP: Windows spawn plan resolved',
      );
      command = spawnPlan.command;
      args = spawnPlan.args;
      if (spawnPlan.shell !== undefined) {
        spawnOpts.shell = spawnPlan.shell;
      }
    }

    const providerCommand = command;
    const providerArgs = args;
    if (!IS_WINDOWS && !this.config.spawnFn) {
      const supervised = buildUnixSupervisedSpawnPlan(command, args, {
        env: childEnv,
        killGraceMs: Math.max(250, KILL_GRACE_MS - 1_000),
      });
      command = supervised.command;
      args = supervised.args;
      spawnOpts.env = supervised.env;
    }

    this.child = doSpawn(command, args, spawnOpts) as ChildProcess;

    this.child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trimEnd();
      log.warn({ pid: this.child?.pid }, '[acp stderr] %s', text);
      if (CAPACITY_RE.test(text)) {
        const signal: AcpCapacitySignal = { message: text.slice(0, 300), timestamp: Date.now() };
        this._recentCapacitySignal = signal;
        for (const fn of this.capacityListeners) fn(signal);
      }
    });

    this.child.on('error', (err) => {
      log.error('ACP process error: %s', err.message);
      this.exited = true;
      this.rejectAllPending(err);
    });

    this.child.on('exit', (code, signal) => {
      log.info('ACP process exited: code=%s signal=%s', code, signal);
      this.exited = true;
      this.rejectAllPending(new Error(`ACP process exited: code=${code} signal=${signal}`));
    });

    this.startReading();

    log.info(
      buildAcpSpawnLogFields({
        command: providerCommand,
        args: providerArgs,
        cwd: this.config.cwd,
        pid: this.child.pid,
        env: this.config.env,
      }),
      'ACP initialize: process spawned, sending initialize request',
    );
    const resp = await this.sendRequest(ACP_METHODS.initialize, { protocolVersion: 1 });
    this.initResult = resp.result as unknown as AcpInitializeResult;
    log.info(
      {
        agentInfo: this.initResult.agentInfo,
        mcpCapabilities: this.initResult.agentCapabilities?.mcpCapabilities,
        loadSession: this.initResult.agentCapabilities?.loadSession,
        pid: this.child?.pid,
      },
      'ACP initialize: agent ready',
    );
    return this.initResult;
  }

  async newSession(cwd?: string, mcpServers: AcpMcpServer[] = []): Promise<AcpNewSessionResult> {
    // F161: Filter MCP servers by client's announced mcpCapabilities.
    // Per ACP spec: stdio is mandatory (always passes), http/sse are optional.
    const compatible = this.filterMcpByCapabilities(mcpServers);
    if (compatible.length !== mcpServers.length) {
      log.info(
        {
          total: mcpServers.length,
          compatible: compatible.length,
          dropped: mcpServers.length - compatible.length,
          droppedNames: mcpServers.filter((s) => !compatible.includes(s)).map((s) => s.name),
          capabilities: this.initResult?.agentCapabilities?.mcpCapabilities ?? 'unknown',
        },
        'ACP: filtered incompatible MCP servers by client mcpCapabilities',
      );
    }

    const effectiveCwd = cwd ?? this.config.cwd;
    // F161 diagnostic: log the full session/new payload shape for timeout debugging
    log.info(
      {
        cwd: effectiveCwd,
        mcpServerCount: compatible.length,
        mcpServers: compatible.map((s) => ({
          name: s.name,
          transport: 'type' in s ? s.type : 'stdio',
          // For stdio: log command + args (no env values — security)
          ...('command' in s ? { command: s.command, argCount: s.args.length } : {}),
          // For http/sse: log url presence
          ...('url' in s ? { hasUrl: !!s.url } : {}),
          envKeyCount: 'env' in s && Array.isArray(s.env) ? s.env.length : 0,
          envKeys: 'env' in s && Array.isArray(s.env) ? (s.env as Array<{ name: string }>).map((e) => e.name) : [],
        })),
        agentInfo: this.initResult?.agentInfo,
        pid: this.child?.pid,
      },
      'ACP session/new: sending request',
    );

    const t0 = Date.now();
    const resp = await this.sendRequest(ACP_METHODS.sessionNew, {
      cwd: effectiveCwd,
      mcpServers: compatible,
    });
    log.info({ durationMs: Date.now() - t0, hasResult: !!resp.result }, 'ACP session/new: response received');
    return resp.result as unknown as AcpNewSessionResult;
  }

  async loadSession(sessionId: string, cwd?: string, mcpServers: AcpMcpServer[] = []): Promise<AcpNewSessionResult> {
    const compatible = this.filterMcpByCapabilities(mcpServers);
    if (compatible.length !== mcpServers.length) {
      log.info(
        {
          total: mcpServers.length,
          compatible: compatible.length,
          dropped: mcpServers.length - compatible.length,
          droppedNames: mcpServers.filter((s) => !compatible.includes(s)).map((s) => s.name),
          capabilities: this.initResult?.agentCapabilities?.mcpCapabilities ?? 'unknown',
        },
        'ACP loadSession: filtered incompatible MCP servers by client mcpCapabilities',
      );
    }

    const effectiveCwd = cwd ?? this.config.cwd;
    log.info(
      { sessionId, cwd: effectiveCwd, mcpServerCount: compatible.length, pid: this.child?.pid },
      'ACP session/load: sending request',
    );
    const t0 = Date.now();
    const resp = await this.sendRequest(ACP_METHODS.sessionLoad, {
      sessionId,
      cwd: effectiveCwd,
      mcpServers: compatible,
    });
    log.info(
      { sessionId, durationMs: Date.now() - t0, hasResult: !!resp.result },
      'ACP session/load: response received',
    );
    return resp.result as unknown as AcpNewSessionResult;
  }

  async setSessionConfigOption(sessionId: string, configId: string, value: string): Promise<void> {
    const trimmedConfigId = configId.trim();
    const trimmedValue = value.trim();
    if (!trimmedConfigId || !trimmedValue) return;

    log.info(
      { sessionId, configId: trimmedConfigId, value: trimmedValue, pid: this.child?.pid },
      'ACP session/set_config_option: sending request',
    );
    const t0 = Date.now();
    await this.sendRequest(ACP_METHODS.sessionSetConfigOption, {
      sessionId,
      configId: trimmedConfigId,
      value: trimmedValue,
    });
    log.info({ sessionId, durationMs: Date.now() - t0 }, 'ACP session/set_config_option: response received');
  }

  /**
   * Send a prompt, collect all streaming events, return { events, stopReason }.
   *
   * Phase B will add a streaming generator variant for real-time UI updates.
   */
  async promptCollect(
    sessionId: string,
    text: string,
    options?: { timeoutMs?: number },
  ): Promise<{ events: AcpSessionUpdate[]; stopReason: AcpStopReason }> {
    const events: AcpSessionUpdate[] = [];
    const timeoutMs = options?.timeoutMs ?? 120_000;
    let notifResolve: ((n: AcpNotification) => void) | null = null;

    const listener = (notif: AcpNotification) => {
      const params = notif.params as unknown as AcpSessionUpdate;
      if (params.sessionId !== sessionId) return;
      if (notifResolve) {
        const r = notifResolve;
        notifResolve = null;
        r(notif);
      }
      events.push(params);
    };
    this.notificationListeners.push(listener);

    try {
      const promptPromise = this.sendRequest(
        ACP_METHODS.sessionPrompt,
        { sessionId, prompt: [{ type: 'text', text }] },
        timeoutMs,
      );
      const resp = await promptPromise;
      const result = resp.result as unknown as AcpPromptResult;
      return { events, stopReason: result.stopReason };
    } finally {
      const idx = this.notificationListeners.indexOf(listener);
      if (idx >= 0) this.notificationListeners.splice(idx, 1);
    }
  }

  /**
   * Stream prompt events as they arrive. Yields AcpSessionUpdate per notification.
   * The generator completes when the prompt response arrives from the agent.
   */
  async *promptStream(
    sessionId: string,
    text: string,
    options?: { timeoutMs?: number; idleWarningMs?: number; idleStallMs?: number },
  ): AsyncGenerator<AcpSessionUpdate, AcpStopReason> {
    // KD-12: Activity-based turn budget — resets on each event.
    // If agent produces events continuously, budget never fires. Only triggers
    // after timeoutMs of SILENCE (no events). Idle stall (90s) catches true hangs
    // faster; this is the wider safety net for slow-but-alive sessions.
    // sendRequest gets a wider inactivity window as a last-resort guard. The
    // window is derived from timeoutMs and resets on real prompt activity, so it
    // cannot preempt either the configured idle policy or its sliding budget.
    const timeoutMs = options?.timeoutMs ?? 900_000;
    const idleWarningMs = options?.idleWarningMs ?? 20_000;
    // Idle stall catches true hangs. Gemini CLI doesn't emit tool_call for MCP
    // tools, so pendingTool never activates. 90s covers most MCP calls (10-30s).
    const idleStallMs = options?.idleStallMs ?? 90_000;
    const requestCeilingMs = resolveAcpPromptRequestCeilingMs(timeoutMs);
    const queue: AcpSessionUpdate[] = [];
    let waitResolve: (() => void) | null = null;
    let done = false;
    let stopReason: AcpStopReason = 'end_turn';
    let promptError: Error | null = null;

    // F149: Stream idle watchdog state
    let eventCount = 0;
    let lastEventAt = 0;
    let idleWarningFired = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingTool = false; // true while Gemini is waiting for MCP tool result
    let budgetTimer: ReturnType<typeof setTimeout> | null = null;
    const promptRequestId = randomUUID();

    /** Reset (or start) the activity-based turn budget timer.
     *  Called once at prompt start and again on every incoming event. */
    const resetBudget = () => {
      if (budgetTimer) clearTimeout(budgetTimer);
      if (done) return;
      budgetTimer = setTimeout(() => {
        if (done) return;
        log.error({ sessionId, eventCount, timeoutMs }, 'Turn budget exceeded — no activity for %dms', timeoutMs);
        this.cancelSession(sessionId);
        promptError = new AcpTimeoutError('session/prompt', timeoutMs);
        done = true;
        if (waitResolve) {
          const r = waitResolve;
          waitResolve = null;
          r();
        }
      }, timeoutMs);
    };

    /** Inject a synthetic event and wake the consumer loop. */
    const injectSynthetic = (update: Record<string, unknown>) => {
      queue.push({ sessionId, update } as AcpSessionUpdate);
      if (waitResolve) {
        const r = waitResolve;
        waitResolve = null;
        r();
      }
    };

    /** Schedule the next idle check. Active from prompt start — covers zero-first-event.
     *  #1186: Previously only started after the first real event, so zero-event stalls
     *  could only be caught by the budget timer (at idleTtlMs + 60s) with AcpTimeoutError.
     *  Now the idle watchdog owns the terminal transition for all silence, including
     *  zero-first-event, producing AcpStreamIdleError at the configured TTL. */
    const scheduleIdleCheck = () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (done) return;
      // P1-fix: stall delay is relative to lastEventAt, not relative to warning.
      // With warning at 20s and stall at 45s, the stall timer fires 25s after warning.
      // Cap initial delay at idleStallMs so short TTLs (< idleWarningMs) still fire on time.
      const nextMs = idleWarningFired ? Math.max(0, idleStallMs - idleWarningMs) : Math.min(idleWarningMs, idleStallMs);
      idleTimer = setTimeout(() => {
        if (done) return;
        // Clamp to at least the threshold that triggered this timer — a threshold
        // event must never report a duration smaller than its own trigger point.
        const rawIdle = Date.now() - lastEventAt;
        const idleSinceMs = Math.max(rawIdle, idleWarningFired ? idleStallMs : idleWarningMs);
        if (!idleWarningFired) {
          idleWarningFired = true;
          if (pendingTool) {
            // Tool is executing — idle is expected, don't alarm
            log.info({ sessionId, idleSinceMs, eventCount, pendingTool }, 'Stream idle watchdog: tool wait');
            injectSynthetic({
              sessionUpdate: 'stream_tool_wait_warning',
              idleSinceMs,
              eventCount,
              timestamp: Date.now(),
            });
          } else {
            log.warn({ sessionId, idleSinceMs, eventCount }, 'Stream idle watchdog: warning');
            injectSynthetic({ sessionUpdate: 'stream_idle_warning', idleSinceMs, eventCount, timestamp: Date.now() });
          }
          scheduleIdleCheck(); // Schedule stall check (remaining time)
        } else if (pendingTool) {
          // #1186: Tool execution ceiling follows the configured idleStallMs (from member's
          // ACP Idle TTL), not a hardcoded constant. Previously TOOL_EXECUTION_CEILING_MS=180s
          // killed tools that legitimately needed more time, ignoring user-configured idle TTL.
          if (idleSinceMs >= idleStallMs) {
            log.error(
              { sessionId, idleSinceMs, eventCount, pendingTool, idleStallMs },
              'Stream idle watchdog: tool execution exceeded configured idle TTL — terminating',
            );
            this.cancelSession(sessionId);
            promptError = new AcpStreamIdleError(sessionId, idleSinceMs, eventCount, idleStallMs);
            done = true;
            if (waitResolve) {
              const r = waitResolve;
              waitResolve = null;
              r();
            }
          } else {
            log.info(
              { sessionId, idleSinceMs, eventCount, pendingTool, idleStallMs },
              'Stream idle watchdog: tool still pending, scheduling follow-up check',
            );
            scheduleIdleCheck(); // Reschedule — don't dead-end
          }
        } else {
          // Stall — terminate the stream and cancel the upstream session
          log.error({ sessionId, idleSinceMs, eventCount }, 'Stream idle watchdog: stall — terminating');
          this.cancelSession(sessionId); // P1-fix: actually cancel the upstream session
          promptError = new AcpStreamIdleError(sessionId, idleSinceMs, eventCount, idleStallMs);
          done = true;
          if (waitResolve) {
            const r = waitResolve;
            waitResolve = null;
            r();
          }
        }
      }, nextMs);
    };

    const listener = (notif: AcpNotification) => {
      const params = notif.params as unknown as AcpSessionUpdate;
      if (params.sessionId !== sessionId) return;
      queue.push(params);
      // F149: Track real events for idle watchdog
      eventCount++;
      lastEventAt = Date.now();
      idleWarningFired = false; // Reset warning on new activity
      // Track tool execution phase for idle watchdog.
      // Gemini CLI sends events in two formats: nested (params.update.sessionUpdate)
      // and flat (params.sessionUpdate) — must handle both, same as acp-event-transformer.
      const inner = (params.update ?? params) as Record<string, unknown>;
      const updateType = inner.sessionUpdate as string | undefined;
      // Diagnostic: log every event type + raw keys for unclassified events
      if (updateType) {
        log.info({ sessionId, eventCount, updateType, pendingTool }, 'ACP listener: event received');
      } else {
        // Unknown event — dump raw structure to diagnose Gemini CLI payload format
        const rawKeys = Object.keys(params);
        const innerKeys = params.update ? Object.keys(params.update as Record<string, unknown>) : [];
        const method = (notif as unknown as Record<string, unknown>).method;
        log.warn(
          { sessionId, eventCount, method, rawKeys, innerKeys, pendingTool, raw: JSON.stringify(params).slice(0, 500) },
          'ACP listener: unclassified event — no sessionUpdate type',
        );
      }
      if (updateType === 'tool_call' || updateType === 'permission_pending') {
        pendingTool = true;
      } else if (
        pendingTool &&
        updateType !== 'tool_call_update' &&
        updateType !== 'agent_thought_chunk' // Thought chunks during tool execution are normal — don't reset
      ) {
        pendingTool = false; // Real output event → tool execution completed
      }
      scheduleIdleCheck();
      resetBudget(); // Activity-based: any event resets the turn budget
      this.pending.get(promptRequestId)?.refreshTimeout();
      if (waitResolve) {
        const r = waitResolve;
        waitResolve = null;
        r();
      }
    };
    this.notificationListeners.push(listener);

    // F149: Inject capacity signals (stderr 429) into the event queue.
    // This breaks through zero-event stalls where the for-await loop blocks
    // on an empty queue — the signal resolves waitResolve immediately.
    const capacityInjector = (signal: AcpCapacitySignal) => {
      injectSynthetic({
        sessionUpdate: 'provider_capacity_signal',
        message: signal.message,
        timestamp: signal.timestamp,
      });
    };
    this.capacityListeners.add(capacityInjector);

    // #1186 P1: Register cancel callback so cancelSession() settles this stream
    // immediately instead of waiting for the provider or idle watchdog.
    const cancelCb = () => {
      if (done) return;
      // The local stream can settle before the provider acknowledges prompt
      // termination. The pool uses this only for single-flight retirement.
      this.unquiescedSessionIds.add(sessionId);
      log.info({ sessionId, eventCount }, 'Session cancel settled local prompt stream');
      promptError = new AcpStreamIdleError(
        sessionId,
        Date.now() - (lastEventAt || Date.now()),
        eventCount,
        idleStallMs,
      );
      done = true;
      if (idleTimer) clearTimeout(idleTimer);
      if (budgetTimer) clearTimeout(budgetTimer);
      if (waitResolve) {
        const r = waitResolve;
        waitResolve = null;
        r();
      }
    };
    this.sessionCancelCallbacks.set(sessionId, cancelCb);

    // #1186: Initialize lastEventAt so idle watchdog measures from prompt start for
    // zero-first-event case. When real events arrive, lastEventAt is updated in the listener.
    lastEventAt = Date.now();

    // Start activity-based budget timer — resets on each event from listener
    resetBudget();

    // #1186: Start idle watchdog at prompt start — covers zero-first-event path.
    // Previously only started from the listener (on first real event), leaving zero-event
    // stalls uncovered until the budget timer fired at idleTtlMs + 60s.
    scheduleIdleCheck();

    // Fire prompt request — don't await, we'll drain the queue concurrently.
    // The request timeout is a last-resort inactivity window that is wider than
    // the activity budget and rearmed by the listener on every real event.
    // #1186 P1: Pre-generate the request ID so cancelSession() can settle the pending
    // entry. Without this, the sendRequest promise stays alive after generator exit,
    // leaving a stale entry in `pending` that blocks safe non-multiplexed reuse.
    this.sessionPromptPendingIds.set(sessionId, promptRequestId);
    this.sendRequest(
      ACP_METHODS.sessionPrompt,
      { sessionId, prompt: [{ type: 'text', text }] },
      requestCeilingMs,
      promptRequestId,
    )
      .then((resp) => {
        const result = resp.result as unknown as AcpPromptResult;
        stopReason = result.stopReason;
      })
      .catch((err: Error) => {
        // Local termination (idle watchdog, activity budget, or explicit cancel)
        // rejects the pending protocol request as cleanup. Preserve the terminal
        // cause that already settled the stream instead of replacing it with the
        // generic cancellation rejection while queued events are still draining.
        if (done && promptError) return;
        if (err instanceof AcpTimeoutError) this.unquiescedSessionIds.add(sessionId);
        promptError = err;
      })
      .finally(() => {
        done = true;
        if (waitResolve) {
          const r = waitResolve;
          waitResolve = null;
          r();
        }
      });

    try {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        if (done) break;
        await new Promise<void>((r) => {
          waitResolve = r;
        });
      }
      // Drain any remaining events that arrived between done flag and the loop check
      while (queue.length > 0) {
        yield queue.shift()!;
      }
      if (promptError) throw promptError;
      return stopReason;
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      if (budgetTimer) clearTimeout(budgetTimer);
      this.sessionCancelCallbacks.delete(sessionId);
      this.sessionPromptPendingIds.delete(sessionId);
      this.capacityListeners.delete(capacityInjector);
      const idx = this.notificationListeners.indexOf(listener);
      if (idx >= 0) this.notificationListeners.splice(idx, 1);
    }
  }

  /**
   * Send session/cancel notification (fire-and-forget, no response expected).
   *
   * #1186 P1: Also settles the local prompt stream via the registered cancel
   * callback so the pending .next() resolves immediately. Without this, the
   * generator stays suspended until the provider cooperates or the idle watchdog
   * fires — leaving the lease pinned for the full TTL. The callback also marks
   * the carrier unsafe for single-flight reuse; the pool retires non-multiplexed
   * clients while leaving multiplexed clients available to unrelated sessions.
   */
  cancelSession(sessionId: string): void {
    const promptReqId = this.sessionPromptPendingIds.get(sessionId);
    const cb = this.sessionCancelCallbacks.get(sessionId);

    if (this.child?.stdin?.writable) {
      const msg = { jsonrpc: '2.0', method: ACP_METHODS.sessionCancel, params: { sessionId } };
      this.child.stdin.write(`${JSON.stringify(msg)}\n`);
      log.info('Sent session/cancel for %s', sessionId);
    }
    // Settle the local prompt stream immediately
    if (cb) cb();
    // #1186 P1: Settle the pending sendRequest promise for this session's prompt.
    // The cancel callback above exits the generator, which releases the lease.
    // But without settling the underlying request, the sendRequest promise stays
    // alive with its request timer, leaving a stale entry in `pending`. For a non-
    // multiplexed process that remains alive after lease release, the stale entry
    // would retain its timer and could consume a late response. Rejecting here
    // clears local bookkeeping; the pool separately retires non-multiplexed
    // carriers because local cleanup does not prove upstream quiescence.
    if (promptReqId) {
      const entry = this.pending.get(promptReqId);
      if (entry) {
        this.pending.delete(promptReqId);
        entry.reject(new Error(`Session ${sessionId} cancelled — prompt request settled`));
      }
      this.sessionPromptPendingIds.delete(sessionId);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    this.rl?.close();
    if (this.child && !this.child.killed) {
      // Register exit listener BEFORE kill to avoid race with sync emitters
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (this.child && !this.child.killed) {
            this.child.kill('SIGKILL');
          }
          resolve();
        }, KILL_GRACE_MS);
        this.child!.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
        this.child!.kill('SIGTERM');
      });
    }
    this.rejectAllPending(new Error('ACP client closed'));
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get isAlive(): boolean {
    return this.child !== null && !this.child.killed && !this.closed && !this.exited;
  }

  /**
   * #1203: False when the bootstrap cwd was deleted after spawn (e.g. by an
   * external cleaner emptying the shared /tmp bootstrap root) — including the
   * delete→recreate case where the path exists again but the child still holds
   * the dead inode, so getcwd() keeps failing. The pool retires cwd-less
   * processes and cold-starts fresh ones (initialize re-creates the cwd).
   */
  get isCwdIntact(): boolean {
    return this.cwdIdentityTracker.isIntact;
  }

  get isSafeForSingleFlightReuse(): boolean {
    return this.unquiescedSessionIds.size === 0;
  }

  isSessionSafeForReuse(sessionId: string): boolean {
    return !this.unquiescedSessionIds.has(sessionId);
  }

  /** Register a capacity-signal listener scoped to a prompt's lifetime. */
  onCapacity(fn: (signal: AcpCapacitySignal) => void): void {
    this.capacityListeners.add(fn);
  }

  /** Unregister a capacity-signal listener. */
  offCapacity(fn: (signal: AcpCapacitySignal) => void): void {
    this.capacityListeners.delete(fn);
  }

  /** Number of pending (unresolved) sendRequest entries. Used by tests to verify
   *  cancel settles the underlying prompt request and doesn't leave stale entries. */
  get pendingRequestCount(): number {
    return this.pending.size;
  }

  /** Most recent capacity signal observed on this client (provider-level, not per-invoke). */
  get recentCapacitySignal(): AcpCapacitySignal | null {
    return this._recentCapacitySignal;
  }

  /** Clear capacity signal after a successful prompt — provider has recovered. */
  clearRecentCapacitySignal(): void {
    this._recentCapacitySignal = null;
  }

  // ── MCP Capability Filtering ─────────────────────────────────

  /**
   * Filter MCP servers to only those compatible with the client's capabilities.
   *
   * Per the ACP spec (agentclientprotocol.com/protocol/v1/initialization):
   *   - stdio is MANDATORY — all ACP agents MUST support it; not listed in mcpCapabilities
   *   - mcpCapabilities only advertises OPTIONAL transports: { http?: boolean; sse?: boolean }
   *
   * Transport detection:
   *   - Has `type: 'http'` → needs mcpCapabilities.http === true
   *   - Has `type: 'sse'`  → needs mcpCapabilities.sse === true
   *   - Has `command` (no type) → stdio; always passes (mandatory per ACP spec)
   *
   * If initResult is unavailable, all servers pass through (permissive fallback).
   */
  private filterMcpByCapabilities(servers: AcpMcpServer[]): AcpMcpServer[] {
    const caps = this.initResult?.agentCapabilities?.mcpCapabilities;
    if (!caps) return servers; // no capability info → pass all (backward compat)

    return servers.filter((s) => {
      if ('type' in s) {
        if (s.type === 'http') return caps.http === true;
        if (s.type === 'sse') return caps.sse === true;
        return false; // unknown type
      }
      // Stdio server (has command, no type field) — mandatory per ACP spec, always pass
      return true;
    });
  }

  // ── Internal ─────────────────────────────────────────────────

  private startReading(): void {
    if (!this.child?.stdout) throw new Error('ACP process has no stdout');
    this.rl = createInterface({ input: this.child.stdout });

    this.rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        log.warn('ACP stdout non-JSON: %s', trimmed.slice(0, 120));
        return;
      }

      // #712: id can be 0 (Kimi CLI uses numeric ids starting at 0).
      // `0` is falsy in JS, so use explicit null check instead of truthiness.
      const id = msg.id as string | number | undefined;
      const hasId = id !== undefined && id !== null;
      const idStr = hasId ? String(id) : undefined;
      const method = msg.method as string | undefined;

      if (hasId && idStr && this.pending.has(idStr) && !method) {
        // Response to one of our requests
        const { resolve } = this.pending.get(idStr)!;
        this.pending.delete(idStr);
        resolve(msg as unknown as AcpResponse);
      } else if (method && hasId) {
        // Request from agent (permission, fs, terminal) — needs our response.
        // Checked before notifications so id:0 (Kimi) is not misrouted.
        this.handleAgentRequest(msg as unknown as AcpAgentRequest);
      } else if (method && !hasId) {
        if (method === ACP_METHODS.requestPermission) {
          // Gemini CLI sends request_permission as notification (no id) when not in yolo mode.
          // Best-effort auto-approve with synthetic id (Gemini may ignore it).
          // Also notify stream listeners so idle watchdog suppresses stall during permission wait.
          const permParams = msg.params as Record<string, unknown>;
          log.info(
            { method, sessionId: permParams.sessionId },
            'ACP: permission notification (no id) — auto-approve + suppress stall',
          );
          this.handleAgentRequest({ ...msg, id: `synth-perm-${Date.now()}` } as unknown as AcpAgentRequest);
          // Inject synthetic event into stream so promptStream sets pendingTool=true
          for (const listener of this.notificationListeners) {
            listener({
              jsonrpc: '2.0',
              method: ACP_METHODS.sessionUpdate,
              params: { sessionId: permParams.sessionId, sessionUpdate: 'permission_pending' },
            } as unknown as AcpNotification);
          }
        } else {
          // Notification from agent (session/update)
          for (const listener of this.notificationListeners) {
            listener(msg as unknown as AcpNotification);
          }
        }
      }
    });
  }

  private sendRequest(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = 60_000,
    /** Pre-generated request ID — used by promptStream to enable cancel-time settlement. */
    preGeneratedId?: string,
  ): Promise<AcpResponse> {
    const child = this.child;
    const stdin = child?.stdin;
    if (!child || !stdin?.writable) {
      return Promise.reject(new Error('ACP process stdin not writable'));
    }

    const id = preGeneratedId ?? randomUUID();
    const msg = { jsonrpc: '2.0', method, id, params };
    const payload = JSON.stringify(msg);
    log.info(
      { method, id, timeoutMs, pid: child.pid, payloadBytes: payload.length },
      'ACP sendRequest: writing to stdin',
    );

    return new Promise<AcpResponse>((resolve, reject) => {
      const sentAt = Date.now();
      let timeoutStartedAt = sentAt;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const armTimeout = () => {
        if (timer) clearTimeout(timer);
        timeoutStartedAt = Date.now();
        timer = setTimeout(() => {
          this.pending.delete(id);
          log.error(
            {
              method,
              id,
              timeoutMs,
              pid: child.pid,
              elapsedMs: Date.now() - sentAt,
              inactiveMs: Date.now() - timeoutStartedAt,
              exited: this.exited,
            },
            'ACP sendRequest: TIMEOUT — no response from agent process',
          );
          // For prompt timeouts, send session/cancel to stop the agent's internal retry loop
          if (method === ACP_METHODS.sessionPrompt && params.sessionId) {
            this.cancelSession(params.sessionId as string);
          }
          reject(new AcpTimeoutError(method, timeoutMs));
        }, timeoutMs);
      };

      const pendingRequest: PendingAcpRequest = {
        resolve: (resp) => {
          if (timer) clearTimeout(timer);
          log.info(
            { method, id, durationMs: Date.now() - sentAt, hasError: !!resp.error },
            'ACP sendRequest: response received',
          );
          if (resp.error) {
            reject(new AcpProtocolError(resp.error.code, resp.error.message, resp.error.data));
          } else {
            resolve(resp);
          }
        },
        reject: (err) => {
          if (timer) clearTimeout(timer);
          log.error({ method, id, durationMs: Date.now() - sentAt, error: err.message }, 'ACP sendRequest: rejected');
          reject(err);
        },
        refreshTimeout: armTimeout,
      };
      this.pending.set(id, pendingRequest);
      armTimeout();
      stdin.write(`${payload}\n`);
    });
  }

  private handleAgentRequest(req: AcpAgentRequest): void {
    if (req.method === ACP_METHODS.requestPermission) {
      const respond = (result: { optionId: string }) => {
        // ACP spec: response must wrap in { outcome: { outcome: "selected", optionId } }
        const acpResult = {
          outcome: { outcome: 'selected' as const, optionId: result.optionId },
        };
        const response = { jsonrpc: '2.0' as const, id: req.id, result: acpResult };
        this.child?.stdin?.write(JSON.stringify(response) + '\n');
        log.debug('Permission response for %s: %s', req.id, result.optionId);
      };

      if (this.config.permissionHandler) {
        try {
          this.config.permissionHandler(req, respond);
        } catch (err) {
          log.error('permissionHandler threw: %s', (err as Error).message);
          const errResponse = {
            jsonrpc: '2.0' as const,
            id: req.id,
            error: { code: -32603, message: `Permission handler error: ${(err as Error).message}` },
          };
          this.child?.stdin?.write(JSON.stringify(errResponse) + '\n');
        }
      } else {
        // Default: auto-approve (allow_once)
        const params = req.params as unknown as AcpPermissionRequest;
        // Prefer allow_always (session-wide) over allow_once to avoid repeated permission
        // prompts for every MCP tool call. Kimi sends optionId "approve_for_session" for this.
        const allowOption =
          params.options?.find((o) => o.kind === 'allow_always') ??
          params.options?.find((o) => o.kind === 'allow_once') ??
          params.options?.[0];
        respond({ optionId: allowOption?.optionId ?? 'allow_once' });
      }
    } else {
      // Unknown agent request — respond with method not found
      log.warn('Unhandled agent request: %s', req.method);
      const response = {
        jsonrpc: '2.0' as const,
        id: req.id,
        error: { code: -32601, message: `Client does not handle ${req.method}` },
      };
      this.child?.stdin?.write(JSON.stringify(response) + '\n');
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [id, { reject }] of this.pending) {
      reject(error);
      this.pending.delete(id);
    }
  }
}
