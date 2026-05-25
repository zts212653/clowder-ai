import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { dirname, join } from 'node:path';
import { createModuleLogger } from '../../../../../../infrastructure/logger.js';
import type { IRuntimeSessionStore } from '../../../runtime-session/RuntimeSessionStore.js';
import {
  type AntigravityCascadeHealthSnapshot,
  type AntigravityCascadeHealthThresholds,
  assessAntigravityCascadeHealth,
  cascadeHealthThresholdsFromEnv,
} from './antigravity-cascade-health.js';
import { discoverAntigravityLS } from './antigravity-ls-discovery.js';
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
// Antigravity 2.x rejects the proto default 0 (UNSPECIFIED) for StartCascade.
// The IDE client defaults regular conversations to CASCADE_CLIENT.
const CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT = 1;

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

  constructor(
    private readonly connection?: Partial<BridgeConnection>,
    options?: BridgeOptions,
  ) {
    this.sessionStorePath = options?.sessionStorePath ?? DEFAULT_SESSION_STORE;
    this.runtimeSessionStore = options?.runtimeSessionStore;
  }

  getRuntimeSessionStoreForDiagnostics(): IRuntimeSessionStore | undefined {
    return this.runtimeSessionStore;
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
  async sendMessage(cascadeId: string, text: string, modelName?: string): Promise<number> {
    const traj = await this.getTrajectory(cascadeId);
    const stepsBefore = traj.numTotalSteps ?? 0;
    const modelId = modelName ? this.modelMap[modelName] : undefined;
    const payload: Record<string, unknown> = {
      cascadeId,
      items: [{ text }],
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

  async getTrajectory(cascadeId: string): Promise<CascadeTrajectory> {
    return this.rpcSafe<CascadeTrajectory>('GetCascadeTrajectory', { cascadeId });
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

  async getOrCreateSession(threadId: string, catId?: string): Promise<string> {
    this.loadSessionMap();

    const key = catId ? `${threadId}:${catId}` : threadId;
    const candidates = [this.sessionMap.get(key)];
    if (catId && !candidates[0]) candidates.push(this.sessionMap.get(threadId));

    for (const cascadeId of candidates) {
      if (!cascadeId) continue;
      try {
        const traj = await this.getTrajectory(cascadeId);
        if (traj.status !== 'CASCADE_RUN_STATUS_IDLE') {
          log.info(`cascade ${cascadeId} stuck in ${traj.status} for ${key}, creating new`);
          continue;
        }
        if (this.sessionMap.get(key) !== cascadeId) {
          this.sessionMap.set(key, cascadeId);
          this.sessionMap.delete(threadId);
          this.deletedKeys.add(threadId);
          this.persistSessionMap();
          log.info(`migrated legacy key ${threadId} → ${key}`);
        }
        log.debug(`reusing cascade ${cascadeId} for ${key}`);
        return cascadeId;
      } catch {
        log.info(`cascade ${cascadeId} dead for ${key}, creating new`);
      }
    }

    const newCascadeId = await this.startCascade();
    this.sessionMap.set(key, newCascadeId);
    this.deletedKeys.delete(key);
    this.persistSessionMap();
    return newCascadeId;
  }

  resetSession(threadId: string, catId?: string): void {
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
