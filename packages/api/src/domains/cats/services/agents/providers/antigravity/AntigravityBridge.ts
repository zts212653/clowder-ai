import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { dirname, join } from 'node:path';
import { createModuleLogger } from '../../../../../../infrastructure/logger.js';
import { discoverAntigravityLS } from './antigravity-ls-discovery.js';
import { diffDeliveredSteps } from './antigravity-step-delta.js';
import { RAW_RESPONSE_CAP, TRACE_ENABLED, TRACED_METHODS, traceLog } from './antigravity-trace.js';
import type { AuditSink, ExecutorResult } from './executors/AntigravityToolExecutor.js';
import type { ExecutorRegistry } from './executors/ExecutorRegistry.js';
import { formatToolResult } from './executors/formatToolResult.js';
import { getRunCommandRefusalReason } from './executors/RunCommandExecutor.js';

const log = createModuleLogger('antigravity-bridge');

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
  trajectory?: { steps: TrajectoryStep[] };
}

export interface DeliveryCursor {
  baselineStepCount: number;
  lastDeliveredStepCount: number;
  terminalSeen: boolean;
  lastActivityAt: number;
  awaitingUserInput?: boolean;
}

export interface StepBatch {
  steps: TrajectoryStep[];
  cursor: DeliveryCursor;
}

export interface BridgeOptions {
  sessionStorePath?: string;
}

const DEFAULT_SESSION_STORE = join(process.cwd(), 'data', 'antigravity-sessions.json');

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

  constructor(
    private readonly connection?: Partial<BridgeConnection>,
    options?: BridgeOptions,
  ) {
    this.sessionStorePath = options?.sessionStorePath ?? DEFAULT_SESSION_STORE;
  }

  attachExecutors(registry: ExecutorRegistry, audit: AuditSink): void {
    this.executorRegistry = registry;
    this.executorAudit = audit;
  }

  /**
   * Public RPC entrypoint for executors that need to reach the Antigravity LS.
   * Resolves connection lazily. Keeps the private rpc() signature internal.
   */
  async callRpc<T = Record<string, unknown>>(method: string, payload: unknown): Promise<T> {
    return this.rpcSafe<T>(method, payload);
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

    const executor = this.executorRegistry.resolve(step);
    if (!executor) return 'no_executor' as const;

    const argsJson = step.metadata?.toolCall?.argumentsJson;
    if (!argsJson) return false;
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(argsJson) as Record<string, unknown>;
    } catch (err) {
      log.warn(`nativeExecuteAndPush: failed to parse argumentsJson: ${err}`);
      return false;
    }

    // Respect Antigravity's approval metadata: only auto-execute steps the model
    // explicitly marked as safe-to-auto-run. SafeToAutoRun=false / missing → fall
    // back to normal approval flow (user or autoApprove via HandleCascadeUserInteraction).
    // Return 'approval_pending' (truthy) so callers can distinguish from genuinely unsupported steps (false).
    if (args.SafeToAutoRun !== true) return 'approval_pending';

    const commandLine = ((args.CommandLine as string | undefined) ?? (args.commandLine as string | undefined))?.trim();
    if (!commandLine) return false;
    const cwd = (args.Cwd as string | undefined) ?? (args.cwd as string | undefined) ?? opts.cwd;
    const input = { commandLine, cwd };

    const trajectoryId = step.metadata?.sourceTrajectoryStepInfo?.trajectoryId ?? '';
    const stepIndex = step.metadata?.sourceTrajectoryStepInfo?.stepIndex;
    if (stepIndex == null) {
      log.warn(
        'nativeExecuteAndPush: stepIndex missing from sourceTrajectoryStepInfo, skipping to avoid cancelling wrong step',
      );
      return false;
    }

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

    // Stage 1: try to satisfy LS PermissionManager before invoking the native executor.
    // If the hint RPC itself fails, still continue to the writeback fallback path.
    try {
      await this.approveInteraction(opts.cascadeId, {
        permission: { allowed: true },
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
    const resp = await this.rpcSafe<{ cascadeId?: string }>('StartCascade', { source: 0 });
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

    while (true) {
      if (signal?.aborted) throw new Error('Aborted');

      let traj: CascadeTrajectory;
      try {
        traj = await this.getTrajectory(cascadeId);
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

      if (currentSteps > delivered || hadMutation) {
        waitingApprovalSignaled = false;
        lastActivityAt = Date.now();
        const newSteps = allSteps.slice(delivered, currentSteps);
        const emittedSteps = replaySteps.concat(newSteps);
        delivered = currentSteps;
        deliveredFingerprints = nextFingerprints;
        deliveredPlannerTexts = nextPlannerTexts;
        log.debug(
          `cascade delivery: ${emittedSteps.length} emitted steps (new=${newSteps.length}, mutated=${replaySteps.length}, total=${currentSteps}, terminal=${isTerminal})`,
        );
        yield {
          steps: emittedSteps,
          cursor: {
            baselineStepCount: stepsBefore,
            lastDeliveredStepCount: delivered,
            terminalSeen: isTerminal,
            lastActivityAt,
            awaitingUserInput,
          },
        };
        if (isTerminal) return;
      } else {
        const idleMs = Date.now() - lastActivityAt;
        if (awaitingUserInput) {
          if (!waitingApprovalSignaled) {
            waitingApprovalSignaled = true;
            log.info(`cascade ${cascadeId} awaiting user input; suppressing stall timeout`);
            yield {
              steps: [],
              cursor: {
                baselineStepCount: stepsBefore,
                lastDeliveredStepCount: delivered,
                terminalSeen: false,
                lastActivityAt,
                awaitingUserInput: true,
              },
            };
          }
          await new Promise((r) => setTimeout(r, pollIntervalMs));
          continue;
        }
        waitingApprovalSignaled = false;
        if (isTerminal && (delivered > stepsBefore || idleMs > idleTimeoutMs)) {
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

  private async rpcSafe<T = Record<string, unknown>>(method: string, payload: unknown): Promise<T> {
    let conn = await this.ensureConnected();
    try {
      return await this.rpc<T>(conn, method, payload);
    } catch (err) {
      if (this.isConnectionError(err)) {
        log.warn(`connection lost on ${method}, rediscovering LS...`);
        this.invalidateConnection();
        conn = await this.ensureConnected();
        return this.rpc<T>(conn, method, payload);
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

  private rpc<T = Record<string, unknown>>(conn: BridgeConnection, method: string, payload: unknown): Promise<T> {
    const mod = conn.useTls ? https : http;
    const protocol = conn.useTls ? 'https' : 'http';
    const url = `${protocol}://127.0.0.1:${conn.port}/exa.language_server_pb.LanguageServerService/${method}`;
    const body = JSON.stringify(payload);

    return new Promise((resolve, reject) => {
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
          timeout: 30_000,
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
                resolve(JSON.parse(data) as T);
              } catch {
                resolve(data as unknown as T);
              }
            } else {
              reject(new Error(`LS ${method}: ${res.statusCode} — ${data.substring(0, 200)}`));
            }
          });
        },
      );
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`LS ${method}: timeout`));
      });
      req.write(body);
      req.end();
    });
  }

  private discoverFromProcess(): Promise<BridgeConnection> {
    return discoverAntigravityLS();
  }
}
