import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { dirname, join } from 'node:path';
import type { CatId } from '@cat-cafe/shared';
import { createModuleLogger } from '../../../../../../infrastructure/logger.js';
import type {
  RuntimeSessionDrainResult,
  RuntimeSessionMetadata,
} from '../../../runtime-session/RuntimeSessionMetadata.js';
import type { IRuntimeSessionStore } from '../../../runtime-session/RuntimeSessionStore.js';
import {
  type AntigravityCascadeHealthSnapshot,
  type AntigravityCascadeHealthThresholds,
  assessAntigravityCascadeHealth,
  cascadeHealthThresholdsFromEnv,
} from './antigravity-cascade-health.js';
import { discoverAntigravityLS } from './antigravity-ls-discovery.js';
import type { AntigravityRuntimeSealReason } from './antigravity-runtime-lifecycle.js';
import { diffDeliveredSteps } from './antigravity-step-delta.js';
import { isReadOnlyMcpTool } from './antigravity-step-effects.js';
import { isLsOwnedApprovalTool, toolNameFromWaitingStep } from './antigravity-tool-surface.js';
import { RAW_RESPONSE_CAP, TRACE_ENABLED, TRACED_METHODS, traceLog } from './antigravity-trace.js';
import type { AntigravityToolExecutor, AuditSink, ExecutorResult } from './executors/AntigravityToolExecutor.js';
import type { ExecutorRegistry } from './executors/ExecutorRegistry.js';
import { formatToolResult } from './executors/formatToolResult.js';
import type { McpToolInput } from './executors/McpToolExecutor.js';
import { getRunCommandRefusalReason, MAX_RUN_COMMAND_TIMEOUT_MS } from './executors/RunCommandExecutor.js';

const log = createModuleLogger('antigravity-bridge');

const DEFAULT_RPC_TIMEOUT_MS = 30_000;
const RUN_COMMAND_RPC_TIMEOUT_BUFFER_MS = 5_000;
// getOrCreateSession's reuse path waits for an owed in-flight tool result before sending the follow-up
// (so it cannot slip ahead of that result). The wait must cover the LONGEST a native tool can run —
// RunCommandExecutor permits up to MAX_RUN_COMMAND_TIMEOUT_MS — or long builds/tests would be abandoned
// mid-flight and corrupt turn order (cloud P1 #9). +60s is a leaked-counter backstop, not the expected
// exit: the executor aborts at its own max and the in-flight count clears first.
export const IN_FLIGHT_WAIT_TIMEOUT_MS = MAX_RUN_COMMAND_TIMEOUT_MS + 60_000;
// Antigravity 2.x rejects the proto default 0 (UNSPECIFIED) for StartCascade.
// The IDE client defaults regular conversations to CASCADE_CLIENT.
const CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT = 1;

class AntigravityDrainDeadlineError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`trajectory read exceeded drain timeout after ${timeoutMs}ms`);
    this.name = 'AntigravityDrainDeadlineError';
  }
}

export function antigravityRpcTimeoutMs(method: string, payload: unknown): number {
  if (method !== 'RunCommand') return DEFAULT_RPC_TIMEOUT_MS;
  if (payload == null) return DEFAULT_RPC_TIMEOUT_MS;
  if (typeof payload !== 'object') return DEFAULT_RPC_TIMEOUT_MS;
  const rawTimeoutMs = (payload as { timeoutMs?: unknown }).timeoutMs;
  if (typeof rawTimeoutMs !== 'number') return DEFAULT_RPC_TIMEOUT_MS;
  if (!Number.isSafeInteger(rawTimeoutMs)) return DEFAULT_RPC_TIMEOUT_MS;
  if (rawTimeoutMs <= 0) return DEFAULT_RPC_TIMEOUT_MS;
  if (rawTimeoutMs > MAX_RUN_COMMAND_TIMEOUT_MS) return DEFAULT_RPC_TIMEOUT_MS;
  return Math.max(DEFAULT_RPC_TIMEOUT_MS, Math.floor(rawTimeoutMs) + RUN_COMMAND_RPC_TIMEOUT_BUFFER_MS);
}

function withDrainDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout?: (error: AntigravityDrainDeadlineError) => void,
): Promise<T> {
  if (timeoutMs <= 0) {
    return Promise.reject(new AntigravityDrainDeadlineError(0));
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => {
      const error = new AntigravityDrainDeadlineError(timeoutMs);
      onTimeout?.(error);
      reject(error);
    }, timeoutMs);
    void promise.then(resolve, reject).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
  });
}

function isDrainDeadlineError(err: unknown): err is AntigravityDrainDeadlineError {
  return err instanceof AntigravityDrainDeadlineError;
}

const HARDCODED_MODEL_MAP: Record<string, string> = {
  'gemini-3.1-pro': 'MODEL_PLACEHOLDER_M37',
  'gemini-3-flash': 'MODEL_PLACEHOLDER_M47',
  'claude-opus-4-6': 'MODEL_PLACEHOLDER_M26',
  'claude-sonnet-4-6': 'MODEL_PLACEHOLDER_M35',
};

export interface BridgeConnection {
  port: number;
  csrfToken: string;
  useTls: boolean;
}

export interface TrajectoryStep {
  type: string;
  status: string;
  /** Internal replay hint for Cat Cafe consumers; never sent by Antigravity LS directly. */
  catCafeTextMode?: 'append' | 'replace';
  plannerResponse?: {
    response?: string;
    modifiedResponse?: string;
    thinking?: string;
    stopReason?: string;
  };
  errorMessage?: {
    error?: { userErrorMessage?: string; modelErrorMessage?: string };
  };
  userInput?: { items?: Array<{ text?: string }> };
  toolCall?: { toolName?: string; input?: string };
  toolResult?: { toolName?: string; success?: boolean; output?: string; error?: string };
  mcpTool?: {
    serverName?: string;
    toolCall?: {
      name?: string;
      argumentsJson?: string;
    };
  };
  metadata?: {
    toolCall?: { id?: string; name?: string; argumentsJson?: string };
    sourceTrajectoryStepInfo?: {
      trajectoryId?: string;
      stepIndex?: number;
      metadataIndex?: number;
      cascadeId?: string;
    };
    [key: string]: unknown;
  };
  requestedInteraction?: {
    permission?: unknown;
    filePermission?: unknown;
    approvalInteraction?: unknown;
    [key: string]: unknown;
  };
  runCommand?: {
    commandLine?: string;
    proposedCommandLine?: string;
    cwd?: string;
    shouldAutoRun?: boolean;
    blocking?: boolean;
    stdout?: string;
    stderr?: string;
    exitCode?: number;
  };
  /** Antigravity built-in `generate_image` step payload. Present on
   *  `CORTEX_STEP_TYPE_GENERATE_IMAGE` steps; the produced file lands at
   *  `<brain>/<cascadeId>/<imageName>_<timestamp>.<ext>` (F172 Phase G). */
  generateImage?: {
    prompt?: string;
    imageName?: string;
    modelName?: string;
    generatedMedia?: {
      mimeType?: string;
      inlineData?: string;
      uri?: string;
    };
  };
  error?: { shortError?: string; fullError?: string };
}

export interface CascadeTrajectory {
  status: string;
  numTotalSteps: number;
  awaitingUserInput?: boolean;
  updatedAt?: number | string;
  trajectory?: { steps: TrajectoryStep[] };
}

export interface AntigravityDrainOptions {
  quietWindowMs?: number;
  timeoutMs?: number;
  pollIntervalMs?: number;
  /** When provided, the drain bails (best_effort) as soon as the signal aborts, so a cancelled
   *  invocation does not block on the quiet-window wait (cloud P2). */
  signal?: AbortSignal;
}

export type AntigravityDrainResult =
  | {
      ok: true;
      drainResult: Extract<RuntimeSessionDrainResult, 'complete' | 'best_effort_quiet_window'>;
      lastObservedStepCount: number;
    }
  | {
      ok: false;
      drainResult: Extract<RuntimeSessionDrainResult, 'best_effort_quiet_window' | 'skipped_runtime_unreachable'>;
      reason: string;
      lastObservedStepCount?: number;
    };

export interface AntigravityResetSessionOptions {
  expectedRuntimeSessionId?: string;
  sealReason?: AntigravityRuntimeSealReason;
  drainResult?: RuntimeSessionDrainResult;
}

export type BridgeLivenessEvidenceKind =
  | 'trajectory_progress'
  | 'trajectory_timestamp_progress'
  | 'step_mutation'
  | 'pending_approval'
  | 'rpc_reconnected';

export interface BridgeLivenessEvidence {
  kind: BridgeLivenessEvidenceKind;
  observedAt: number;
  summary: string;
}

export interface DeliveryCursor {
  baselineStepCount: number;
  lastDeliveredStepCount: number;
  terminalSeen: boolean;
  lastActivityAt: number;
  awaitingUserInput?: boolean;
  lastTrajectoryAt?: number;
  livenessEvidence?: BridgeLivenessEvidence;
}

export interface StepBatch {
  steps: TrajectoryStep[];
  cursor: DeliveryCursor;
}

export interface BridgeOptions {
  sessionStorePath?: string;
  runtimeSessionStore?: IRuntimeSessionStore;
  legacyJsonSessionStore?: boolean;
}

export interface AntigravityRpcOptions {
  signal?: AbortSignal;
}

const DEFAULT_SESSION_STORE = join(process.cwd(), 'data', 'antigravity-sessions.json');

function hasGeneratingPlannerResponse(steps: TrajectoryStep[]): boolean {
  return steps.some(
    (step) => step.type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE' && step.status === 'CORTEX_STEP_STATUS_GENERATING',
  );
}

function trajectoryTimestampMs(trajectory: CascadeTrajectory): number | undefined {
  const updatedAt = trajectory.updatedAt;
  if (typeof updatedAt === 'number' && Number.isFinite(updatedAt)) return updatedAt;
  if (typeof updatedAt === 'string') {
    const parsed = Date.parse(updatedAt);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function positiveIntegerOr(value: number | undefined, fallback: number): number {
  if (!Number.isSafeInteger(value)) return fallback;
  if ((value ?? 0) <= 0) return fallback;
  return Math.floor(value as number);
}

function isMeaningfulDrainStep(step: TrajectoryStep): boolean {
  const type = step.type.toUpperCase();
  const status = step.status.toUpperCase();
  if (type.includes('USER_INPUT')) return false;
  if (type.includes('CHECKPOINT') || type.includes('DEBUG')) return false;
  if (status.includes('CANCELED') || status.includes('CANCELLED')) return false;
  return true;
}

function meaningfulDrainStepCount(trajectory: CascadeTrajectory): number {
  const steps = trajectory.trajectory?.steps;
  if (!Array.isArray(steps)) return trajectory.numTotalSteps ?? 0;
  return steps.filter(isMeaningfulDrainStep).length;
}

function isDrainTrajectoryIdle(trajectory: CascadeTrajectory): boolean {
  return trajectory.status === 'CASCADE_RUN_STATUS_IDLE';
}

function drainQuietWindowTimeoutReason(quietWindowMs: number, lastObservedStatus: string | undefined): string {
  if (lastObservedStatus && lastObservedStatus !== 'CASCADE_RUN_STATUS_IDLE') {
    return `trajectory status ${lastObservedStatus} did not become idle or satisfy quiet window ${quietWindowMs}ms before drain timeout`;
  }
  return `trajectory did not satisfy quiet window ${quietWindowMs}ms before drain timeout`;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  return nonEmptyString(record[key]);
}

function parseJsonObject(raw: string | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function formatNativeToolInvocation(toolName: string, input: Record<string, unknown>): string {
  const serialized = JSON.stringify(input);
  if (serialized === '{}') return toolName;
  const max = 500;
  return `${toolName} ${serialized.length > max ? `${serialized.slice(0, max)}…` : serialized}`;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseMcpArgumentsCandidate(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'string') {
    const raw = nonEmptyString(value);
    if (!raw) return undefined;
    return parseJsonObject(raw) ?? undefined;
  }
  return objectRecord(value) ?? undefined;
}

function mcpToolInputFromStep(step: TrajectoryStep, args: Record<string, unknown>): McpToolInput | null {
  const serverName =
    nonEmptyString(step.mcpTool?.serverName) ??
    stringField(args, 'ServerName') ??
    stringField(args, 'serverName') ??
    stringField(args, 'server_name');
  const toolName =
    nonEmptyString(step.mcpTool?.toolCall?.name) ??
    stringField(args, 'ToolName') ??
    stringField(args, 'toolName') ??
    stringField(args, 'tool_name');
  if (!serverName || !toolName) return null;

  const toolArguments =
    parseMcpArgumentsCandidate(step.mcpTool?.toolCall?.argumentsJson) ??
    parseMcpArgumentsCandidate(args.Arguments) ??
    parseMcpArgumentsCandidate(args.arguments) ??
    parseMcpArgumentsCandidate(args.argumentsJson) ??
    parseMcpArgumentsCandidate(args.input) ??
    {};

  return {
    serverName,
    toolName,
    arguments: toolArguments,
  };
}

export class AntigravityBridge {
  private conn: BridgeConnection | null = null;
  private sessionMap = new Map<string, string>();
  private deletedKeys = new Set<string>();
  private sessionMapLoaded = false;
  private readonly sessionStorePath: string;
  private modelMap: Record<string, string> = { ...HARDCODED_MODEL_MAP };
  private modelMapRefreshed = false;
  private executorRegistry: ExecutorRegistry | null = null;
  private executorAudit: AuditSink | null = null;
  private readonly runtimeSessionStore?: IRuntimeSessionStore;
  private readonly inFlightByCascade = new Map<string, { rpc: number; toolResult: number }>();
  private readonly legacyJsonSessionStore: boolean;

  constructor(
    private readonly connection?: Partial<BridgeConnection>,
    options?: BridgeOptions,
  ) {
    this.sessionStorePath = options?.sessionStorePath ?? DEFAULT_SESSION_STORE;
    this.runtimeSessionStore = options?.runtimeSessionStore;
    this.legacyJsonSessionStore = options?.legacyJsonSessionStore === true;
  }

  getRuntimeSessionStoreForDiagnostics(): IRuntimeSessionStore | undefined {
    return this.runtimeSessionStore;
  }

  getLegacyJsonSessionStoreForDiagnostics(): boolean {
    return this.legacyJsonSessionStore;
  }

  private async withInFlight<T>(cascadeId: string, kind: 'rpc' | 'toolResult', fn: () => Promise<T>): Promise<T> {
    this.incrementInFlight(cascadeId, kind);
    try {
      return await fn();
    } finally {
      this.decrementInFlight(cascadeId, kind);
    }
  }

  private incrementInFlight(cascadeId: string, kind: 'rpc' | 'toolResult'): void {
    const current = this.inFlightByCascade.get(cascadeId) ?? { rpc: 0, toolResult: 0 };
    current[kind] += 1;
    this.inFlightByCascade.set(cascadeId, current);
  }

  private decrementInFlight(cascadeId: string, kind: 'rpc' | 'toolResult'): void {
    const current = this.inFlightByCascade.get(cascadeId);
    if (!current) return;
    current[kind] = Math.max(0, current[kind] - 1);
    if (current.rpc === 0 && current.toolResult === 0) {
      this.inFlightByCascade.delete(cascadeId);
      return;
    }
    this.inFlightByCascade.set(cascadeId, current);
  }

  private getInFlightCount(cascadeId: string): number {
    const current = this.inFlightByCascade.get(cascadeId);
    return current ? current.rpc + current.toolResult : 0;
  }

  attachExecutors(registry: ExecutorRegistry, audit: AuditSink): void {
    this.executorRegistry = registry;
    this.executorAudit = audit;
  }

  /**
   * Public RPC entrypoint for executors that need to reach the Antigravity LS.
   * Resolves connection lazily. Keeps the private rpc() signature internal.
   */
  async callRpc<T = Record<string, unknown>>(
    method: string,
    payload: unknown,
    options?: AntigravityRpcOptions,
  ): Promise<T> {
    return this.rpcSafe<T>(method, payload, options);
  }

  /**
   * F061 Phase 2c Task 5: Coordinator for native tool execution.
   * Dispatches a WAITING RUN_COMMAND step through the executor registry,
   * then pushes the result back via pushToolResult.
   * Returns true on success, 'approval_pending' when SafeToAutoRun is not set,
   * 'no_executor' when no executor matches (caller should fail-fast), or false for
   * all other early exits (kill-switch, missing registry, bad args — caller should not fail-fast).
   * Opt out via `ANTIGRAVITY_NATIVE_EXECUTOR=0` env var.
   */
  async nativeExecuteAndPush(
    step: TrajectoryStep,
    opts: { cascadeId: string; cwd: string; modelName?: string },
  ): Promise<true | 'approval_pending' | 'no_executor' | false> {
    return this.withInFlight(opts.cascadeId, 'rpc', async () => this.nativeExecuteAndPushInner(step, opts));
  }

  private async nativeExecuteAndPushInner(
    step: TrajectoryStep,
    opts: { cascadeId: string; cwd: string; modelName?: string },
  ): Promise<true | 'approval_pending' | 'no_executor' | false> {
    if (process.env.ANTIGRAVITY_NATIVE_EXECUTOR === '0') return false;
    if (!this.executorRegistry || !this.executorAudit) return false;
    if (step.status !== 'CORTEX_STEP_STATUS_WAITING') return false;

    const waitingToolName = toolNameFromWaitingStep(step);
    if (isLsOwnedApprovalTool(waitingToolName)) {
      log.info(`nativeExecuteAndPush: routing LS-owned tool ${waitingToolName} to approval flow`);
      return 'approval_pending' as const;
    }

    const executor = this.executorRegistry.resolve(step);
    if (!executor) return 'no_executor' as const;

    const argsJson = nonEmptyString(step.metadata?.toolCall?.argumentsJson) ?? nonEmptyString(step.toolCall?.input);
    const args = parseJsonObject(argsJson);

    const trajectoryId = step.metadata?.sourceTrajectoryStepInfo?.trajectoryId ?? '';
    const stepIndex = step.metadata?.sourceTrajectoryStepInfo?.stepIndex;
    if (stepIndex == null) {
      log.warn(
        'nativeExecuteAndPush: stepIndex missing from sourceTrajectoryStepInfo, skipping to avoid cancelling wrong step',
      );
      return false;
    }

    if (executor.toolName === 'call_mcp_tool') {
      return await this.nativeExecuteMcpToolAndPush(step, args ?? {}, executor, opts, trajectoryId, stepIndex);
    }

    if (executor.toolName !== 'run_command') {
      if (!isReadOnlyMcpTool(executor.toolName)) {
        log.error(`nativeExecuteAndPush: refusing generic native executor for non-read-only tool ${executor.toolName}`);
        return 'no_executor' as const;
      }
      return await this.nativeExecuteGenericToolAndPush(args ?? {}, executor, opts, trajectoryId, stepIndex);
    }

    if (!argsJson || !args) return false;
    return await this.nativeExecuteRunCommandAndPush(args, executor, opts, trajectoryId, stepIndex);
  }

  private async nativeExecuteMcpToolAndPush(
    step: TrajectoryStep,
    args: Record<string, unknown>,
    executor: AntigravityToolExecutor,
    opts: { cascadeId: string; cwd: string; modelName?: string },
    trajectoryId: string,
    stepIndex: number,
  ): Promise<true | 'no_executor' | false> {
    if (!this.executorAudit) return false;
    const input = mcpToolInputFromStep(step, args);
    if (!input) return 'no_executor';
    const result = await executor.execute(input, {
      cascadeId: opts.cascadeId,
      trajectoryId,
      stepIndex,
      cwd: opts.cwd,
      audit: this.executorAudit,
    });

    await this.pushToolResult(
      opts.cascadeId,
      stepIndex,
      result,
      { commandLine: `${input.serverName}/${input.toolName}`, cwd: opts.cwd },
      opts.modelName,
    );
    return true;
  }

  private async nativeExecuteGenericToolAndPush(
    input: Record<string, unknown>,
    executor: AntigravityToolExecutor,
    opts: { cascadeId: string; cwd: string; modelName?: string },
    trajectoryId: string,
    stepIndex: number,
  ): Promise<true | false> {
    if (!this.executorAudit) return false;
    const result = await executor.execute(input, {
      cascadeId: opts.cascadeId,
      trajectoryId,
      stepIndex,
      cwd: opts.cwd,
      audit: this.executorAudit,
    });

    await this.pushToolResult(
      opts.cascadeId,
      stepIndex,
      result,
      { commandLine: formatNativeToolInvocation(executor.toolName, input), cwd: opts.cwd },
      opts.modelName,
    );
    return true;
  }

  private async nativeExecuteRunCommandAndPush(
    args: Record<string, unknown>,
    executor: AntigravityToolExecutor,
    opts: { cascadeId: string; cwd: string; modelName?: string },
    trajectoryId: string,
    stepIndex: number,
  ): Promise<true | 'approval_pending' | false> {
    if (!this.executorAudit) return false;
    const commandLine = ((args.CommandLine as string | undefined) ?? (args.commandLine as string | undefined))?.trim();
    if (!commandLine) return false;
    const cwd = (args.Cwd as string | undefined) ?? (args.cwd as string | undefined) ?? opts.cwd;
    const input = { commandLine, cwd };

    // Run local refusal rules before signaling LS-side approval. Otherwise an
    // unsafe command could be permission-approved upstream before our native
    // executor decides to refuse it.
    const refusalReason = getRunCommandRefusalReason(commandLine);
    if (refusalReason) {
      const result: ExecutorResult<unknown> = { status: 'refused', reason: refusalReason };
      await this.executorAudit.record({
        tool: executor.toolName,
        cascadeId: opts.cascadeId,
        stepIndex,
        input,
        result,
        timestamp: new Date(),
      });
      await this.pushToolResult(opts.cascadeId, stepIndex, result, input, opts.modelName);
      return true;
    }

    // Antigravity has no usable approval surface in Cat Cafe's runtime path.
    // Default to YOLO for run_command, matching Codex/Claude/OpenCode behavior,
    // while retaining an env opt-out for emergency rollback. Local hard refusal
    // rules above still run before any LS approval/execution.
    const yoloRunCommand = process.env.ANTIGRAVITY_YOLO_RUN_COMMAND !== 'false';
    if (args.SafeToAutoRun !== true && !yoloRunCommand) return 'approval_pending';

    // Stage 1: try to satisfy LS PermissionManager before invoking the native executor.
    // If the hint RPC itself fails, still continue to the writeback fallback path.
    try {
      await this.approveInteraction(opts.cascadeId, {
        permission: { allow: true },
        trajectoryId,
        stepIndex,
      });
    } catch (err) {
      log.warn(`nativeExecuteAndPush: permission guard RPC failed (continuing): ${err}`);
    }

    const result = await executor.execute(input, {
      cascadeId: opts.cascadeId,
      trajectoryId,
      stepIndex,
      cwd,
      audit: this.executorAudit,
    });

    await this.pushToolResult(opts.cascadeId, stepIndex, result, input, opts.modelName);
    return true;
  }

  async ensureConnected(): Promise<BridgeConnection> {
    if (this.conn) return this.conn;
    if (this.connection?.port && this.connection.csrfToken) {
      this.conn = {
        port: this.connection.port,
        csrfToken: this.connection.csrfToken,
        useTls: this.connection.useTls ?? true,
      };
    } else {
      this.conn = await this.discoverFromProcess();
    }
    if (!this.modelMapRefreshed) {
      this.modelMapRefreshed = true;
      await this.refreshModelMap();
    }
    return this.conn;
  }
  async startCascade(): Promise<string> {
    const resp = await this.rpcSafe<{ cascadeId?: string }>('StartCascade', {
      source: CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT,
    });
    if (!resp.cascadeId) throw new Error('StartCascade: no cascadeId returned');
    log.debug(`cascade created: ${resp.cascadeId}`);
    return resp.cascadeId;
  }
  async sendMessage(
    cascadeId: string,
    text: string,
    modelName?: string,
    media?: ReadonlyArray<{ mimeType: string; inlineData: string }>,
  ): Promise<number> {
    const traj = await this.getTrajectory(cascadeId);
    const stepsBefore = traj.numTotalSteps ?? 0;
    const modelId = modelName ? this.modelMap[modelName] : undefined;
    const payload: Record<string, unknown> = {
      cascadeId,
      items: [{ text }],
      // F211 REG3 Layer C: `media` is a TOP-LEVEL field of SendUserCascadeMessage (sibling to
      // `items`, reverse-engineered from the Antigravity IDE). Each item is the flat Connect-JSON
      // wire shape `{ mimeType, inlineData: <base64> }` — NOT the protobuf-es runtime
      // `{ payload: { case: 'inlineData', value } }`. This lets a dispatched cascade SEE images.
      ...(media && media.length > 0 ? { media } : {}),
      cascadeConfig: {
        plannerConfig: {
          plannerTypeConfig: { conversational: {} },
          ...(modelId ? { requestedModel: { model: modelId } } : {}),
        },
      },
    };
    await this.rpcSafe('SendUserCascadeMessage', payload);
    return stepsBefore;
  }
  async getTrajectorySteps(cascadeId: string): Promise<TrajectoryStep[]> {
    const resp = await this.rpcSafe<{ steps?: TrajectoryStep[] }>('GetCascadeTrajectorySteps', { cascadeId });
    return resp.steps ?? [];
  }

  async getTrajectory(cascadeId: string, options?: AntigravityRpcOptions): Promise<CascadeTrajectory> {
    return this.rpcSafe<CascadeTrajectory>('GetCascadeTrajectory', { cascadeId }, options);
  }

  async drainCascade(cascadeId: string, options: AntigravityDrainOptions = {}): Promise<AntigravityDrainResult> {
    const quietWindowMs = positiveIntegerOr(options.quietWindowMs, 500);
    const timeoutMs = positiveIntegerOr(options.timeoutMs, 5_000);
    const pollIntervalMs = Math.min(positiveIntegerOr(options.pollIntervalMs, Math.min(100, quietWindowMs)), timeoutMs);
    const deadline = Date.now() + timeoutMs;
    let lastObservedStepCount: number | undefined;
    let lastObservedStatus: string | undefined;
    let quietSince: number | undefined;

    while (true) {
      // Bail promptly if the invocation was cancelled mid-drain, so getOrCreateSession's reuse path
      // does not block on the quiet-window wait before the service's pre-send abort check (cloud P2).
      if (options.signal?.aborted) {
        return {
          ok: false,
          drainResult: 'best_effort_quiet_window',
          reason: 'drain aborted by signal',
          ...(lastObservedStepCount === undefined ? {} : { lastObservedStepCount }),
        };
      }
      const inFlightCount = this.getInFlightCount(cascadeId);
      if (inFlightCount > 0) {
        return {
          ok: false,
          drainResult: 'best_effort_quiet_window',
          reason: `cascade ${cascadeId} still has ${inFlightCount} in-flight operation(s)`,
          ...(lastObservedStepCount === undefined ? {} : { lastObservedStepCount }),
        };
      }

      let trajectory: CascadeTrajectory;
      try {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          return {
            ok: false,
            drainResult: 'best_effort_quiet_window',
            reason: drainQuietWindowTimeoutReason(quietWindowMs, lastObservedStatus),
            ...(lastObservedStepCount === undefined ? {} : { lastObservedStepCount }),
          };
        }
        const trajectoryReadController = new AbortController();
        // Abort the in-progress read on EITHER our drain deadline OR the caller's signal, so a cancel
        // landing mid-getTrajectory returns promptly instead of waiting out the deadline (cloud P2). The
        // caller (settle) re-checks signal.aborted right after the drain and bails, so the resulting
        // rejection's classification does not matter.
        const readSignal = options.signal
          ? AbortSignal.any([trajectoryReadController.signal, options.signal])
          : trajectoryReadController.signal;
        trajectory = await withDrainDeadline(
          this.getTrajectory(cascadeId, { signal: readSignal }),
          remainingMs,
          (error) => trajectoryReadController.abort(error),
        );
      } catch (err) {
        if (isDrainDeadlineError(err)) {
          return {
            ok: false,
            drainResult: 'best_effort_quiet_window',
            reason: err.message,
            ...(lastObservedStepCount === undefined ? {} : { lastObservedStepCount }),
          };
        }
        return {
          ok: false,
          drainResult: 'skipped_runtime_unreachable',
          reason: String(err),
          ...(lastObservedStepCount === undefined ? {} : { lastObservedStepCount }),
        };
      }

      const stepCount = meaningfulDrainStepCount(trajectory);
      const now = Date.now();
      if (
        lastObservedStepCount === undefined ||
        stepCount !== lastObservedStepCount ||
        trajectory.status !== lastObservedStatus
      ) {
        lastObservedStepCount = stepCount;
        lastObservedStatus = trajectory.status;
        quietSince = now;
      } else if (isDrainTrajectoryIdle(trajectory) && quietSince !== undefined && now - quietSince >= quietWindowMs) {
        return {
          ok: true,
          drainResult: 'complete',
          lastObservedStepCount: stepCount,
        };
      }

      if (now >= deadline) {
        return {
          ok: false,
          drainResult: 'best_effort_quiet_window',
          reason: drainQuietWindowTimeoutReason(quietWindowMs, trajectory.status),
          lastObservedStepCount: stepCount,
        };
      }

      await sleep(Math.max(1, Math.min(pollIntervalMs, deadline - now)));
    }
  }

  async getCascadeHealth(
    cascadeId: string,
    thresholds: AntigravityCascadeHealthThresholds = cascadeHealthThresholdsFromEnv(),
  ): Promise<AntigravityCascadeHealthSnapshot> {
    const trajectory = await this.getTrajectory(cascadeId);
    return assessAntigravityCascadeHealth({
      cascadeId,
      trajectory,
      thresholds,
      checkedAt: Date.now(),
    });
  }

  async *pollForSteps(
    cascadeId: string,
    stepsBefore = 0,
    idleTimeoutMs = 60_000,
    pollIntervalMs = 2_000,
    signal?: AbortSignal,
  ): AsyncGenerator<StepBatch> {
    let delivered = stepsBefore;
    let lastActivityAt = Date.now();
    let waitingApprovalSignaled = false;
    let rpcRetries = 0;
    const maxRpcRetries = 3;
    let deliveredFingerprints: string[] = [];
    let deliveredPlannerTexts: string[] = [];
    let lastTrajectoryAt: number | undefined;

    while (true) {
      if (signal?.aborted) throw new Error('Aborted');

      let traj: CascadeTrajectory;
      let recoveredAfterRpcError = false;
      try {
        traj = await this.getTrajectory(cascadeId);
        recoveredAfterRpcError = rpcRetries > 0;
        rpcRetries = 0;
      } catch (err) {
        rpcRetries++;
        if (rpcRetries > maxRpcRetries) throw err;
        log.warn(`poll RPC error (retry ${rpcRetries}/${maxRpcRetries}): ${err}`);
        this.invalidateConnection();
        await new Promise((r) => setTimeout(r, pollIntervalMs * rpcRetries));
        continue;
      }
      const currentSteps = traj.numTotalSteps ?? 0;
      const isTerminal = traj.status === 'CASCADE_RUN_STATUS_IDLE';
      const awaitingUserInput = traj.awaitingUserInput === true;
      const trajectoryAt = trajectoryTimestampMs(traj);
      const previousTrajectoryAt = lastTrajectoryAt;
      if (trajectoryAt !== undefined) lastTrajectoryAt = trajectoryAt;
      const trajectoryTimestampAdvanced =
        trajectoryAt !== undefined && previousTrajectoryAt !== undefined && trajectoryAt > previousTrajectoryAt;
      const hasInlineSteps = Array.isArray(traj.trajectory?.steps);
      const shouldFetchForNewSteps = currentSteps > delivered;
      const shouldFetchForMutation = currentSteps > 0 && deliveredFingerprints.length > 0 && hasInlineSteps;
      const shouldSeedDeliveredSnapshots = currentSteps > 0 && delivered > 0 && deliveredFingerprints.length === 0;

      let allSteps: TrajectoryStep[] = [];
      let replaySteps: TrajectoryStep[] = [];
      let nextFingerprints = deliveredFingerprints;
      let nextPlannerTexts = deliveredPlannerTexts;
      let hadMutation = false;

      if (shouldFetchForNewSteps || shouldFetchForMutation || shouldSeedDeliveredSnapshots) {
        allSteps = traj.trajectory?.steps ?? (await this.getTrajectorySteps(cascadeId));
      }

      if (shouldSeedDeliveredSnapshots) {
        const seeded = diffDeliveredSteps(allSteps, 0, [], []);
        deliveredFingerprints = seeded.nextFingerprints;
        deliveredPlannerTexts = seeded.nextPlannerTexts;
        nextFingerprints = seeded.nextFingerprints;
        nextPlannerTexts = seeded.nextPlannerTexts;
      }

      if (shouldFetchForNewSteps || shouldFetchForMutation) {
        const diff = diffDeliveredSteps(allSteps, delivered, deliveredFingerprints, deliveredPlannerTexts);
        replaySteps = diff.replaySteps;
        nextFingerprints = diff.nextFingerprints;
        nextPlannerTexts = diff.nextPlannerTexts;
        hadMutation = diff.hadMutation;
      }
      const terminalReady = isTerminal && !hasGeneratingPlannerResponse(allSteps);

      if (currentSteps > delivered || hadMutation) {
        waitingApprovalSignaled = false;
        lastActivityAt = Date.now();
        const newSteps = allSteps.slice(delivered, currentSteps);
        const emittedSteps = replaySteps.concat(newSteps);
        const livenessEvidence: BridgeLivenessEvidence =
          currentSteps > delivered
            ? {
                kind: 'trajectory_progress',
                observedAt: Date.now(),
                summary: `trajectory step count advanced from ${delivered} to ${currentSteps}`,
              }
            : {
                kind: 'step_mutation',
                observedAt: Date.now(),
                summary: `trajectory step content mutated at delivered count ${delivered}`,
              };
        delivered = currentSteps;
        deliveredFingerprints = nextFingerprints;
        deliveredPlannerTexts = nextPlannerTexts;
        log.debug(
          `cascade delivery: ${emittedSteps.length} emitted steps (new=${newSteps.length}, mutated=${replaySteps.length}, total=${currentSteps}, terminal=${terminalReady})`,
        );
        yield {
          steps: emittedSteps,
          cursor: {
            baselineStepCount: stepsBefore,
            lastDeliveredStepCount: delivered,
            terminalSeen: terminalReady,
            lastActivityAt,
            awaitingUserInput,
            ...(trajectoryAt === undefined ? {} : { lastTrajectoryAt: trajectoryAt }),
            livenessEvidence,
          },
        };
        if (terminalReady) return;
      } else {
        const idleMs = Date.now() - lastActivityAt;
        if (awaitingUserInput) {
          if (!waitingApprovalSignaled) {
            waitingApprovalSignaled = true;
            log.info(`cascade ${cascadeId} awaiting user input; suppressing stall timeout`);
            const livenessEvidence: BridgeLivenessEvidence = {
              kind: 'pending_approval',
              observedAt: Date.now(),
              summary: 'trajectory is awaiting user approval',
            };
            yield {
              steps: [],
              cursor: {
                baselineStepCount: stepsBefore,
                lastDeliveredStepCount: delivered,
                terminalSeen: false,
                lastActivityAt,
                awaitingUserInput: true,
                ...(trajectoryAt === undefined ? {} : { lastTrajectoryAt: trajectoryAt }),
                livenessEvidence,
              },
            };
          }
          await new Promise((r) => setTimeout(r, pollIntervalMs));
          continue;
        }
        waitingApprovalSignaled = false;
        if (terminalReady && (delivered > stepsBefore || idleMs > idleTimeoutMs)) {
          yield {
            steps: [],
            cursor: {
              baselineStepCount: stepsBefore,
              lastDeliveredStepCount: delivered,
              terminalSeen: true,
              lastActivityAt,
              awaitingUserInput: false,
            },
          };
          return;
        }
        if (idleMs > idleTimeoutMs) {
          throw new Error(
            `Antigravity stall: no activity for ${idleMs}ms (steps=${currentSteps}, status=${traj.status})`,
          );
        }
        if (!isTerminal && trajectoryTimestampAdvanced) {
          const livenessEvidence: BridgeLivenessEvidence = {
            kind: recoveredAfterRpcError ? 'rpc_reconnected' : 'trajectory_timestamp_progress',
            observedAt: Date.now(),
            summary: recoveredAfterRpcError
              ? `LS-RPC reconnected and trajectory timestamp advanced from ${previousTrajectoryAt} to ${trajectoryAt}`
              : `trajectory timestamp advanced from ${previousTrajectoryAt} to ${trajectoryAt}`,
          };
          yield {
            steps: [],
            cursor: {
              baselineStepCount: stepsBefore,
              lastDeliveredStepCount: delivered,
              terminalSeen: false,
              lastActivityAt,
              awaitingUserInput: false,
              lastTrajectoryAt: trajectoryAt,
              livenessEvidence,
            },
          };
          await new Promise((r) => setTimeout(r, pollIntervalMs));
          continue;
        }
      }

      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
  }

  /**
   * Wait for a responsive RUNNING cascade to settle to a clean next-turn boundary with NO owed
   * in-flight tool result, draining for the polling baseline. Returns true → reuse (settled clean);
   * false → replace (it became unreachable, or never settled before deadlineMs). In-flight work can
   * re-appear between the wait and the drain (a new tool result), so it loops until nothing is owed.
   */
  private async settleRunningCascadeForReuse(
    cascadeId: string,
    deadlineMs: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    while (Date.now() < deadlineMs) {
      // Honor a user cancel that arrives mid-wait: stop blocking immediately and reuse the existing
      // cascade (don't spin a wasteful replacement) — the caller re-checks the signal before any
      // sendMessage, so nothing is sent for an aborted request (cloud P1, line 1029).
      if (signal?.aborted) return true;
      // (a) Wait for any owed in-flight tool result to clear (P1 #7/#9) — its owed pushToolResult /
      //     SendUserCascadeMessage must land before the caller's follow-up, or turn order corrupts.
      while (this.getInFlightCount(cascadeId) > 0 && Date.now() < deadlineMs && !signal?.aborted) {
        await sleep(100);
      }
      if (signal?.aborted) return true;
      // Deadline reached with work still in flight → replace rather than burn a guaranteed-useless drain
      // (it would just early-return on the in-flight count, cloud P3). NOTE: only when the DEADLINE passed
      // — a non-zero count before the deadline means a NEW tool result appeared and we must loop/re-wait
      // (handled below), so do not short-circuit that case.
      if (Date.now() >= deadlineMs && this.getInFlightCount(cascadeId) > 0) return false;
      // (b) Drain to a quiet next-turn boundary so the caller's sendMessage sets a correct baseline (P1 #1).
      //     Pass the signal so the drain itself bails promptly if the invocation is cancelled mid-drain
      //     (cloud P2) — otherwise it could block on the quiet-window wait for up to its timeout.
      const drain = await this.drainCascade(cascadeId, { timeoutMs: 120_000, signal });
      if (signal?.aborted) return true; // cancelled during the drain → bail; the invoke aborts before send
      if (drain.drainResult === 'skipped_runtime_unreachable') return false; // vanished mid-drain → replace (P2)
      // A new tool result may have started during the drain (drainCascade early-returns while any work is
      // in flight). Reuse only once nothing is owed; otherwise loop and wait again (cloud P1, line 1015).
      if (this.getInFlightCount(cascadeId) === 0) return true;
    }
    return false; // never settled before the deadline → replace, do not risk ordering corruption
  }

  async getOrCreateSession(threadId: string, catId?: string, signal?: AbortSignal): Promise<string> {
    const key = catId ? `${threadId}:${catId}` : threadId;
    let runtimeStoreReplacementTarget: RuntimeSessionMetadata | null = null;
    if (this.runtimeSessionStore && catId) {
      const active = await this.runtimeSessionStore.getActiveByThreadCat(
        'antigravity-desktop',
        threadId,
        catId as CatId,
      );
      if (active) {
        try {
          const traj = await this.getTrajectory(active.runtimeSessionId);
          // F211-REG5 (final). Reuse only a cascade that is a valid CONTINUATION target, so Bengal's
          // follow-up queues into the SAME cascade (memory preserved); everything else REPLACES so REG2's
          // fresh-cascade + continuity-bootstrap path re-injects his context (replace is NOT bare amnesia).
          // The 'user_cancel' that triggers this re-summon is a spurious internal abort (the server turn
          // keeps running), so we never trust it; and step progress is NOT a liveness signal (a constant
          // step count means "thinking", not "dead"; cloud P1 #2-#6). Continuable (reuse) states:
          //   • IDLE — turn finished → reuse, no drain.
          //   • RUNNING + awaitingUserInput — paused for an approval / the next user message → reuse, NO
          //     drain: it never returns to IDLE (it waits for the very message we are about to send), so
          //     draining would block the follow-up for the whole timeout (cloud P1 #8).
          //   • RUNNING, no native tool in flight (model-only thinking/research) — reuse now, no drain
          //     (cloud line 984); only an owed in-flight tool result needs ordering.
          //   • RUNNING with a native tool in flight — settle (wait for the owed result + drain) first.
          // Everything else REPLACES: a reachable but TERMINAL/non-runnable status (ERROR / CANCELLED /
          // DONE, or any unrecognized status) is NOT continuable — reusing it would pin the follow-up to
          // a dead cascade (cloud P1 #10) — as does an unreachable cascade (getTrajectory throws, below).
          let reuseCascadeId: string | undefined;
          const continuable = traj.status === 'CASCADE_RUN_STATUS_IDLE' || traj.status === 'CASCADE_RUN_STATUS_RUNNING';
          if (continuable) {
            if (this.getInFlightCount(active.runtimeSessionId) > 0) {
              // A native tool result is in flight for ANY continuable state — IDLE (a pushToolResult
              // still delivering while the trajectory already reads back IDLE), RUNNING mid-turn, OR
              // awaitingUserInput (Antigravity reads RUNNING/awaiting precisely BECAUSE it is waiting on
              // that owed tool result). Reusing now would let the follow-up jump ahead of the owed
              // pushToolResult / synthetic message → turn-order corruption (cloud P1 #7/#9 + the IDLE and
              // awaiting same-class edges). So this counter gate MUST come BEFORE the awaitingUserInput
              // shortcut: settle (wait for it to clear + drain) first. settleRunningCascadeForReuse is
              // abort-aware (line 1029) and returns false → REPLACE if the cascade vanished mid-drain (P2)
              // or never settled within IN_FLIGHT_WAIT_TIMEOUT_MS.
              const settled = await this.settleRunningCascadeForReuse(
                active.runtimeSessionId,
                Date.now() + IN_FLIGHT_WAIT_TIMEOUT_MS,
                signal,
              );
              if (settled) {
                reuseCascadeId = active.runtimeSessionId;
              }
            } else if (traj.status === 'CASCADE_RUN_STATUS_RUNNING' && traj.awaitingUserInput === true) {
              // Paused for an approval / the next user message with NOTHING in flight → reuse, NO drain:
              // it never returns to IDLE (it waits for the very message we are about to send), so draining
              // would block the follow-up for the whole timeout (cloud P1 #8).
              reuseCascadeId = active.runtimeSessionId;
            } else {
              // IDLE (turn done) or RUNNING with no native tool in flight (model-only thinking/research):
              // nothing owed → reuse now, no drain, letting Antigravity natively queue the follow-up. The
              // ordering guard only waits when getInFlightCount > 0 — draining every running cascade would
              // recreate REG5 as a multi-minute silent delay on the busy path (cloud line 984).
              reuseCascadeId = active.runtimeSessionId;
            }
          }
          if (reuseCascadeId) {
            log.debug(`reusing continuable runtime-store cascade ${reuseCascadeId} (${traj.status}) for ${key}`);
            return reuseCascadeId;
          }
          // Not a valid continuation target — a reachable but terminal/unknown status (cloud P1 #10) or a
          // cascade that became unreachable during the drain (cloud P2) → replace (REG2 fresh + bootstrap).
          log.info(
            `runtime-store cascade ${active.runtimeSessionId} not continuable (status ${traj.status}) for ${key}, creating new`,
          );
          runtimeStoreReplacementTarget = active;
        } catch {
          // getTrajectory threw → the cascade is unreachable / gone → replace (REG2 fresh + bootstrap).
          log.info(`runtime-store cascade ${active.runtimeSessionId} unreachable for ${key}, creating new`);
          runtimeStoreReplacementTarget = active;
        }
      }
    }

    const canReadLegacyJson = this.runtimeSessionStore === undefined && this.legacyJsonSessionStore;
    if (canReadLegacyJson) this.loadSessionMap();

    const candidates = canReadLegacyJson ? [this.sessionMap.get(key)] : [];
    if (canReadLegacyJson && catId && !candidates[0]) candidates.push(this.sessionMap.get(threadId));

    for (const cascadeId of candidates) {
      if (!cascadeId) continue;
      try {
        const traj = await this.getTrajectory(cascadeId);
        if (traj.status !== 'CASCADE_RUN_STATUS_IDLE') {
          log.info(`cascade ${cascadeId} stuck in ${traj.status} for ${key}, creating new`);
          continue;
        }
        if (!this.runtimeSessionStore && this.legacyJsonSessionStore && this.sessionMap.get(key) !== cascadeId) {
          this.sessionMap.set(key, cascadeId);
          this.sessionMap.delete(threadId);
          this.deletedKeys.add(threadId);
          this.persistSessionMap();
          log.info(`migrated legacy key ${threadId} → ${key}`);
        }
        log.debug(`reusing ${this.runtimeSessionStore ? 'legacy JSON fallback' : 'cascade'} ${cascadeId} for ${key}`);
        return cascadeId;
      } catch {
        log.info(`cascade ${cascadeId} dead for ${key}, creating new`);
      }
    }

    const newCascadeId = await this.startCascade();
    if (runtimeStoreReplacementTarget) {
      await this.persistRuntimeStoreReplacement(runtimeStoreReplacementTarget, newCascadeId);
    } else if (!this.runtimeSessionStore && this.legacyJsonSessionStore) {
      this.sessionMap.set(key, newCascadeId);
      this.deletedKeys.delete(key);
      this.persistSessionMap();
    }
    return newCascadeId;
  }

  private async persistRuntimeStoreReplacement(
    active: RuntimeSessionMetadata,
    runtimeSessionId: string,
  ): Promise<void> {
    if (!this.runtimeSessionStore) return;
    const now = Date.now();
    const replacement: RuntimeSessionMetadata = {
      sessionId: active.sessionId,
      runtime: active.runtime,
      runtimeSessionId,
      ...(active.threadId ? { threadId: active.threadId } : {}),
      catId: active.catId,
      ...(active.userId ? { userId: active.userId } : {}),
      surface: active.surface,
      identityHistory: active.identityHistory,
      lifecycle: {
        state: 'active',
        startedAt: active.lifecycle.startedAt,
        lastObservedAt: Math.max(active.lifecycle.lastObservedAt, now),
      },
    };

    await this.runtimeSessionStore.upsert(replacement);
    log.info(`runtime-store active binding ${active.runtimeSessionId} → ${runtimeSessionId}`);
  }

  async resetSession(threadId: string, catId?: string, options: AntigravityResetSessionOptions = {}): Promise<void> {
    if (this.runtimeSessionStore && catId) {
      try {
        const active = await this.runtimeSessionStore.getActiveByThreadCat(
          'antigravity-desktop',
          threadId,
          catId as CatId,
        );
        if (!active) return;
        if (
          options.expectedRuntimeSessionId !== undefined &&
          active.runtimeSessionId !== options.expectedRuntimeSessionId
        ) {
          log.warn(
            {
              threadId,
              catId,
              expectedRuntimeSessionId: options.expectedRuntimeSessionId,
              activeRuntimeSessionId: active.runtimeSessionId,
            },
            'skipped Antigravity runtime reset because active binding changed',
          );
          return;
        }
        const now = Date.now();
        await this.runtimeSessionStore.updateLifecycle(active.sessionId, {
          state: 'sealed',
          lastObservedAt: Math.max(active.lifecycle.lastObservedAt, now),
          sealReason: options.sealReason ?? 'user_initiated',
          drainResult: options.drainResult ?? 'complete',
        });
      } catch (error) {
        log.warn(
          {
            err: error,
            threadId,
            catId,
            expectedRuntimeSessionId: options.expectedRuntimeSessionId,
          },
          'failed to seal Antigravity runtime metadata during reset',
        );
      }
      return;
    }

    if (this.runtimeSessionStore || !this.legacyJsonSessionStore) return;

    this.loadSessionMap();

    const key = catId ? `${threadId}:${catId}` : threadId;
    this.sessionMap.delete(key);
    this.deletedKeys.add(key);

    if (catId) {
      this.sessionMap.delete(threadId);
      this.deletedKeys.add(threadId);
    }

    this.persistSessionMap();
  }

  async resolveOutstandingSteps(cascadeId: string): Promise<void> {
    await this.rpcSafe('ResolveOutstandingSteps', { cascadeId });
    log.info(`resolved outstanding steps for cascade ${cascadeId}`);
  }

  async approvePendingInteraction(cascadeId: string, step: TrajectoryStep): Promise<void> {
    if (objectRecord(step.requestedInteraction?.permission)) {
      await this.approvePermissionInteractionStep(cascadeId, step);
      return;
    }
    if (step.type === 'CORTEX_STEP_TYPE_CODE_ACTION') {
      await this.approveCodeActionStep(cascadeId, step);
      return;
    }
    await this.resolveOutstandingSteps(cascadeId);
  }

  private async approvePermissionInteractionStep(cascadeId: string, step: TrajectoryStep): Promise<void> {
    const sourceStepInfo = step.metadata?.sourceTrajectoryStepInfo;
    const stepIndex = sourceStepInfo?.stepIndex;
    if (typeof stepIndex !== 'number') {
      throw new Error('permission approval requires sourceTrajectoryStepInfo stepIndex');
    }

    const trajectoryId = nonEmptyString(sourceStepInfo?.trajectoryId);
    if (!trajectoryId) {
      throw new Error('permission approval requires sourceTrajectoryStepInfo trajectoryId');
    }

    await this.approveInteraction(cascadeId, {
      permission: { allow: true },
      trajectoryId,
      stepIndex,
    });
    log.info(`approved pending permission for cascade ${cascadeId} step ${stepIndex}`);
  }

  private async approveCodeActionStep(cascadeId: string, step: TrajectoryStep): Promise<void> {
    await this.acknowledgeCodeActionStep(cascadeId, step);
  }

  private async acknowledgeCodeActionStep(cascadeId: string, step: TrajectoryStep): Promise<void> {
    const stepIndex = step.metadata?.sourceTrajectoryStepInfo?.stepIndex;
    if (typeof stepIndex !== 'number') {
      throw new Error('CODE_ACTION acknowledgement requires sourceTrajectoryStepInfo stepIndex');
    }
    const payload: Record<string, unknown> = { cascadeId, accept: true };
    payload.stepIndices = [stepIndex];
    await this.rpcSafe('AcknowledgeCodeActionStep', payload);
    log.info(
      `acknowledged code action step for cascade ${cascadeId}${
        typeof stepIndex === 'number' ? ` step ${stepIndex}` : ''
      }`,
    );
  }

  async approveInteraction(cascadeId: string, interaction: Record<string, unknown>): Promise<void> {
    await this.rpcSafe('HandleCascadeUserInteraction', { cascadeId, interaction });
    log.info(`approved interaction for cascade ${cascadeId}`);
  }

  /**
   * F061 Phase 2c-I: Bridge-owned tool-result writeback.
   * Cancels a stuck cortex step and injects the tool result as a synthetic user
   * message. The cascade sees the result in a USER_INPUT step on its next turn
   * and continues reasoning. Step shows CANCELED in trajectory (trade-off).
   */
  async pushToolResult(
    cascadeId: string,
    stepIndex: number,
    result: import('./executors/AntigravityToolExecutor.js').ExecutorResult<unknown>,
    input: { commandLine: string; cwd?: string },
    modelName?: string,
  ): Promise<void> {
    return this.withInFlight(cascadeId, 'toolResult', async () =>
      this.pushToolResultInner(cascadeId, stepIndex, result, input, modelName),
    );
  }

  private async pushToolResultInner(
    cascadeId: string,
    stepIndex: number,
    result: import('./executors/AntigravityToolExecutor.js').ExecutorResult<unknown>,
    input: { commandLine: string; cwd?: string },
    modelName?: string,
  ): Promise<void> {
    try {
      await this.rpcSafe('CancelCascadeSteps', { cascadeId, stepIndices: [stepIndex] });
    } catch (err) {
      log.warn(`pushToolResult: CancelCascadeSteps failed (continuing): ${err}`);
    }
    const text = formatToolResult(input, result);
    await this.sendMessage(cascadeId, text, modelName);
    log.info(`pushed tool result for cascade=${cascadeId} step=${stepIndex} status=${result.status}`);
  }

  resolveModelId(modelName: string): string | undefined {
    return this.modelMap[modelName];
  }
  async refreshModelMap(): Promise<void> {
    try {
      const resp = await this.rpcSafe<{ cascadeModelConfigData?: { modelId?: string; displayName?: string }[] }>(
        'GetUserStatus',
        {},
      );
      const configs = resp.cascadeModelConfigData ?? [];
      for (const c of configs) {
        if (c.displayName && c.modelId) this.modelMap[c.displayName] = c.modelId;
      }
      if (configs.length) log.info(`model map refreshed: ${configs.length} entries from GetUserStatus`);
    } catch (err) {
      log.warn(`failed to refresh model map, using hardcoded fallback: ${err}`);
    }
  }
  invalidateConnection(): void {
    this.conn = null;
  }

  private isConnectionError(err: unknown): boolean {
    const msg = String(err);
    return msg.includes('ECONNREFUSED') || msg.includes('ECONNRESET') || msg.includes('EHOSTUNREACH');
  }

  private async rpcSafe<T = Record<string, unknown>>(
    method: string,
    payload: unknown,
    options?: AntigravityRpcOptions,
  ): Promise<T> {
    let conn = await this.ensureConnected();
    try {
      return await this.rpc<T>(conn, method, payload, options);
    } catch (err) {
      if (this.isConnectionError(err)) {
        log.warn(`connection lost on ${method}, rediscovering LS...`);
        this.invalidateConnection();
        conn = await this.ensureConnected();
        return this.rpc<T>(conn, method, payload, options);
      }
      throw err;
    }
  }
  private loadSessionMap(): void {
    if (this.sessionMapLoaded) return;
    this.sessionMapLoaded = true;
    try {
      if (existsSync(this.sessionStorePath)) {
        const raw = JSON.parse(readFileSync(this.sessionStorePath, 'utf8')) as Record<string, string>;
        for (const [k, v] of Object.entries(raw)) {
          this.sessionMap.set(k, v);
        }
        log.info(`loaded ${this.sessionMap.size} session(s) from ${this.sessionStorePath}`);
      }
    } catch (err) {
      log.warn(`failed to load session store: ${err}`);
    }
  }

  private persistSessionMap(): void {
    try {
      const dir = dirname(this.sessionStorePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      let existing: Record<string, string> = {};
      try {
        if (existsSync(this.sessionStorePath)) {
          existing = JSON.parse(readFileSync(this.sessionStorePath, 'utf8')) as Record<string, string>;
        }
      } catch {
        /* corrupt — start fresh */
      }
      const merged = { ...existing, ...Object.fromEntries(this.sessionMap) };
      for (const key of this.deletedKeys) delete merged[key];
      writeFileSync(this.sessionStorePath, JSON.stringify(merged, null, 2));
    } catch (err) {
      log.warn(`failed to persist session store: ${err}`);
    }
  }

  private rpc<T = Record<string, unknown>>(
    conn: BridgeConnection,
    method: string,
    payload: unknown,
    options?: AntigravityRpcOptions,
  ): Promise<T> {
    const mod = conn.useTls ? https : http;
    const protocol = conn.useTls ? 'https' : 'http';
    const url = `${protocol}://127.0.0.1:${conn.port}/exa.language_server_pb.LanguageServerService/${method}`;
    const body = JSON.stringify(payload);
    const signal = options?.signal;

    return new Promise((resolve, reject) => {
      const abortError = (): Error => {
        const reason = signal?.reason;
        return reason instanceof Error ? reason : new Error(`LS ${method}: aborted`);
      };
      if (signal?.aborted) {
        reject(abortError());
        return;
      }

      let settled = false;
      let removeAbortListener = () => {};
      const resolveOnce = (value: T) => {
        if (settled) return;
        settled = true;
        removeAbortListener();
        resolve(value);
      };
      const rejectOnce = (err: Error) => {
        if (settled) return;
        settled = true;
        removeAbortListener();
        reject(err);
      };

      const req = mod.request(
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            'x-codeium-csrf-token': conn.csrfToken,
          },
          rejectUnauthorized: false,
          timeout: antigravityRpcTimeoutMs(method, payload),
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => {
            data += chunk;
          });
          res.on('end', () => {
            if (res.statusCode === 200) {
              if (TRACE_ENABLED && TRACED_METHODS.has(method)) {
                traceLog.info(
                  { method, rawLength: data.length, raw: data.substring(0, RAW_RESPONSE_CAP) },
                  'rpc raw response',
                );
              }
              try {
                resolveOnce(JSON.parse(data) as T);
              } catch {
                resolveOnce(data as unknown as T);
              }
            } else {
              rejectOnce(new Error(`LS ${method}: ${res.statusCode} — ${data.substring(0, 200)}`));
            }
          });
        },
      );
      req.on('error', rejectOnce);
      req.on('timeout', () => {
        const err = new Error(`LS ${method}: timeout`);
        rejectOnce(err);
        req.destroy(err);
      });
      if (signal) {
        const onAbort = () => {
          const err = abortError();
          rejectOnce(err);
          req.destroy(err);
        };
        signal.addEventListener('abort', onAbort, { once: true });
        removeAbortListener = () => signal.removeEventListener('abort', onAbort);
        if (signal.aborted) {
          onAbort();
          return;
        }
      }
      req.write(body);
      req.end();
    });
  }

  private discoverFromProcess(): Promise<BridgeConnection> {
    return discoverAntigravityLS();
  }
}
