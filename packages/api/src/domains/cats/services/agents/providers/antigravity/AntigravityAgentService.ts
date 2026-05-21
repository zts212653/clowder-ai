/**
 * Antigravity Agent Service — Bridge-owned writeback architecture.
 *
 * Replaces CDP WebSocket hack with ConnectRPC via AntigravityBridge.
 * Antigravity thinks (via LS cascade), Bridge reads back and yields AgentMessages.
 */
import { existsSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { type CatId, createCatId } from '@cat-cafe/shared';
import { getCatModel } from '../../../../../../config/cat-models.js';
import { createModuleLogger } from '../../../../../../infrastructure/logger.js';
import {
  GENAI_MODEL,
  GENAI_SYSTEM,
  STREAM_ERROR_PATH,
} from '../../../../../../infrastructure/telemetry/genai-semconv.js';
import {
  antigravityStreamErrorBuffered,
  antigravityStreamErrorExpired,
  antigravityStreamErrorRecovered,
} from '../../../../../../infrastructure/telemetry/instruments.js';
import { normalizeModel } from '../../../../../../infrastructure/telemetry/model-normalizer.js';
import type { AgentMessage, AgentService, AgentServiceOptions, MessageMetadata } from '../../../types.js';
import { appendLocalImagePathHints } from '../image-cli-bridge.js';
import { extractImagePaths } from '../image-paths.js';
import { AntigravityBridge, type BridgeConnection, type TrajectoryStep } from './AntigravityBridge.js';
import { AntigravitySideEffectJournal } from './AntigravitySideEffectJournal.js';
import {
  type AntigravityLivenessEvidence,
  type AntigravityNativeExecutorEvidence,
  type AntigravitySupervisorReceiptState,
  type AntigravitySupervisorRecoveryStrategy,
  type AntigravitySupervisorStatus,
  type AntigravitySupervisorStore,
  InMemoryAntigravitySupervisorStore,
} from './AntigravitySupervisorStore.js';
import type { AntigravityCascadeHealthSnapshot } from './antigravity-cascade-health.js';
import type { UpstreamErrorKind } from './antigravity-event-transformer.js';
import { classifyStep, humanErrorMessage, transformTrajectorySteps } from './antigravity-event-transformer.js';
import {
  collectImagePathsFromSteps,
  publishAntigravityImages,
  scanAndPublishAntigravityBrainImages,
} from './antigravity-image-publisher.js';
import { buildAntigravityRecoveryCardMessage } from './antigravity-recovery-card.js';
import {
  type AntigravityDispatchRelevantStepKind,
  type AntigravityRecoveryDecision,
  decideAntigravityRecovery,
} from './antigravity-recovery-policy.js';
import type { AntigravityResumeContext } from './antigravity-resume-context.js';
import { buildAntigravityResumeContext } from './antigravity-resume-context.js';
import {
  type AntigravityResumeProbeResult,
  type AntigravityResumeTierDecision,
  classifyAntigravityResumeTier,
} from './antigravity-resume-tier.js';
import { classifyAntigravityStepEffect, summarizeAntigravityEffects } from './antigravity-step-effects.js';
import { summarizeStepShape, TRACE_ENABLED, traceLog } from './antigravity-trace.js';
import { AuditLogger } from './executors/AuditLogger.js';
import { ExecutorRegistry } from './executors/ExecutorRegistry.js';
import { ANTIGRAVITY_IDE_READ_TOOL_NAMES, AntigravityIdeReadToolExecutor } from './executors/IdeReadToolExecutor.js';
import { CallMcpToolExecutor } from './executors/McpToolExecutor.js';
import { isReadOnlyRunCommand, RunCommandExecutor } from './executors/RunCommandExecutor.js';

const log = createModuleLogger('antigravity-service');
const STREAM_ERROR_GRACE_WINDOW_MS = 4_500;
const STALL_PROBE_MAX_ATTEMPTS = 2;
const DEFAULT_AUTO_RESUME_MAX_ATTEMPTS = 1;
const DEFAULT_MODEL_CAPACITY_RETRY_DELAYS_MS = [1_000, 3_000, 5_000, 10_000, 15_000, 20_000, 30_000, 36_000];

interface StallProbeBudget {
  attempts: number;
  maxAttempts: number;
}

type StallLivenessEvidence =
  | { kind: 'trajectory_progress'; observedSteps: number; lastDelivered: number }
  | {
      kind: 'trajectory_timestamp_progress';
      observedSteps: number;
      lastDelivered: number;
      trajectoryAt: number;
      previousTrajectoryAt: number;
    };
type AntigravityJournalSummary = ReturnType<AntigravitySideEffectJournal['summary']>;
type AntigravityJournalEntry = AntigravityJournalSummary['entries'][number];

function sanitizeRetryDelays(delays?: readonly number[]): number[] {
  return (delays ?? DEFAULT_MODEL_CAPACITY_RETRY_DELAYS_MS).filter(
    (delay): delay is number => Number.isFinite(delay) && delay >= 0,
  );
}

function sanitizeAutoResumeMaxAttempts(value?: number): number {
  if (value === undefined) return DEFAULT_AUTO_RESUME_MAX_ATTEMPTS;
  if (!Number.isFinite(value)) return DEFAULT_AUTO_RESUME_MAX_ATTEMPTS;
  return Math.max(0, Math.floor(value));
}

function isPathInside(childPath: string, parentPath: string): boolean {
  const rel = relative(parentPath, childPath);
  if (rel === '') return true;
  if (rel.startsWith('..')) return false;
  if (isAbsolute(rel)) return false;
  return true;
}

function resolveResumeProbeTarget(target: string | undefined, workingDirectory: string): string | null {
  if (target === undefined) return null;
  const trimmed = target.trim();
  if (trimmed === '') return null;
  if (/[\n\r]/.test(trimmed)) return null;
  if (!isAbsolute(trimmed) && !workingDirectory) return null;
  return isAbsolute(trimmed) ? resolve(trimmed) : resolve(workingDirectory, trimmed);
}

function isOwnedResumeProbeTarget(resolvedTarget: string): boolean {
  const normalized = resolvedTarget.replaceAll('\\', '/');
  if (normalized.includes('/cat-cafe-antigravity-owned')) return true;
  if (normalized.includes('/.cat-cafe/antigravity/')) return true;
  return false;
}

function isOwnedWorktreeProbeTarget(resolvedTarget: string, workingDirectory: string): boolean {
  if (workingDirectory === '') return false;
  const resolvedWorkingDirectory = resolve(workingDirectory);
  if (!isPathInside(resolvedTarget, resolvedWorkingDirectory)) return false;
  return isOwnedResumeProbeTarget(resolvedWorkingDirectory);
}

function buildAntigravityResumeProbe(
  entry: AntigravityJournalEntry,
  workingDirectory: string,
): AntigravityResumeProbeResult | null {
  if (entry.effectType !== 'code' && entry.effectType !== 'artifact') return null;
  const resolvedTarget = resolveResumeProbeTarget(entry.target, workingDirectory);
  if (!resolvedTarget) return null;

  const ownedBySandbox = isOwnedResumeProbeTarget(resolvedTarget);
  const ownedByWorktree = isOwnedWorktreeProbeTarget(resolvedTarget, workingDirectory);
  let owned = ownedBySandbox;
  if (!owned) owned = ownedByWorktree;

  const ok = owned ? existsSync(resolvedTarget) : false;

  const kind = resolvedTarget.toLowerCase().includes('sentinel') ? 'sentinel_exists' : 'owned_target';
  return {
    kind,
    target: entry.target,
    idempotencyKey: entry.idempotencyKey,
    ok,
    reliable: true,
    owned,
    summary: `${kind}:${entry.target}`,
  };
}

function buildAntigravityResumeProbes(input: {
  journalSummary: AntigravityJournalSummary;
  workingDirectory: string;
}): AntigravityResumeProbeResult[] {
  const probes: AntigravityResumeProbeResult[] = [];
  for (const entry of input.journalSummary.entries) {
    const probe = buildAntigravityResumeProbe(entry, input.workingDirectory);
    if (probe) probes.push(probe);
  }
  return probes;
}

function buildSafeAutoResumePrompt(originalPrompt: string, resumeContext: AntigravityResumeContext): string {
  return `${originalPrompt}\n\n---\n\n[Cat Cafe Antigravity safe auto-resume]\nThe previous Antigravity cascade was interrupted. Continue the same user request in this fresh cascade.\nDo not repeat completed side effects. Use the resumeContext JSON below as the source of truth for completed and pending effects.\n\nresumeContext:\n${JSON.stringify(resumeContext, null, 2)}`;
}

function buildRetrySignal(
  catId: CatId,
  metadata: MessageMetadata,
  attempt: number,
  totalAttempts: number,
  delayMs: number,
  errorKind?: UpstreamErrorKind,
): AgentMessage {
  const seconds = delayMs >= 1000 ? `${Math.round(delayMs / 1000)}s` : `${delayMs}ms`;
  const reason = humanErrorMessage(errorKind ?? 'unknown');
  return {
    type: 'provider_signal',
    catId,
    content: JSON.stringify({
      type: 'warning',
      message: `${reason}，正在自动重试（${attempt}/${totalAttempts}），${seconds} 后继续`,
    }),
    metadata,
    timestamp: Date.now(),
  };
}

function detectStallLivenessFromTrajectory(
  trajectory: { numTotalSteps?: number; awaitingUserInput?: boolean; updatedAt?: number | string },
  lastDelivered: number,
  previousTrajectoryAt?: number,
): StallLivenessEvidence | null {
  const observedSteps = Number.isFinite(trajectory.numTotalSteps) ? Number(trajectory.numTotalSteps) : 0;
  if (trajectory.awaitingUserInput === true) return null;
  if (observedSteps > lastDelivered) {
    return { kind: 'trajectory_progress', observedSteps, lastDelivered };
  }
  const trajectoryAt =
    typeof trajectory.updatedAt === 'number'
      ? trajectory.updatedAt
      : typeof trajectory.updatedAt === 'string'
        ? Date.parse(trajectory.updatedAt)
        : undefined;
  if (
    trajectoryAt !== undefined &&
    Number.isFinite(trajectoryAt) &&
    previousTrajectoryAt !== undefined &&
    trajectoryAt > previousTrajectoryAt
  ) {
    return { kind: 'trajectory_timestamp_progress', observedSteps, lastDelivered, trajectoryAt, previousTrajectoryAt };
  }
  return null;
}

async function sleepWithAbort(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (delayMs <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new Error('Aborted during Antigravity capacity retry backoff'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function buildCallbackFallbackInstructions(callbackEnv?: Record<string, string>): string {
  const apiUrl = callbackEnv?.CAT_CAFE_API_URL?.trim();
  const invocationId = callbackEnv?.CAT_CAFE_INVOCATION_ID?.trim();
  const callbackToken = callbackEnv?.CAT_CAFE_CALLBACK_TOKEN?.trim();
  const threadId = callbackEnv?.CAT_CAFE_THREAD_ID?.trim();
  const catId = callbackEnv?.CAT_CAFE_CAT_ID?.trim() ?? 'antig-opus';
  if (!apiUrl || !invocationId || !callbackToken) return '';

  return `\n[Cat Cafe callback fallback]\n如果当前环境已挂载只读 Cat Cafe MCP（常见为 search_evidence / graph_resolve / list_recent / session-chain / signals），这些读工具可直接使用。共享 Antigravity MCP 的 agent-key 工具（post_message / get_thread_context / list_threads / cross_post_message；如挂了 cat-cafe-limb，limb_* 也同理）必须带 agentKeyCatId="${catId}"，这样 Gemini/Claude variant 会使用各自身份的 sidecar key。当前 invocation / thread 的写回凭证也可通过 run_command 调 HTTP callback。\n- 当前 thread 上下文: curl -fsS "${apiUrl}/api/callbacks/thread-context?invocationId=${invocationId}&callbackToken=${callbackToken}&limit=20"\n- 带关键词过滤: curl -fsS "${apiUrl}/api/callbacks/thread-context?invocationId=${invocationId}&callbackToken=${callbackToken}&keyword=review"\n- 发消息回当前 thread: curl -fsS -X POST "${apiUrl}/api/callbacks/post-message" -H 'Content-Type: application/json' -d '{"invocationId":"${invocationId}","callbackToken":"${callbackToken}","content":"<message>"}'\n- 完整文档（public / static，无需凭证）: curl -fsS "${apiUrl}/api/callbacks/instructions"\n\n[Cold-start onboarding — 新 cascade 必读]\nAntigravity 持久 cascade 累积过多 step 时（>200）会因 context 撑爆产生 empty PLANNER_RESPONSE，这时铲屎官可能让你 New Cascade 重启。**新 cascade 是 fresh state，你之前的工作记忆会丢**。第一次回应铲屎官前，**先把上下文找回来**——只需要用 readonly MCP 白名单里的工具，不依赖任何 callback 凭证。当前 thread / cat 已经在 prompt 里给你了：threadId="${threadId ?? ''}", catId="${catId}"，照搬即可。\n1. **读上几次 session 的工作记忆**：cat_cafe_list_session_chain({ threadId: "${threadId ?? ''}", catId: "${catId}", limit: 5 }) 拿到最近 session 列表 → 对最近的 1-2 个 sessionId 调 cat_cafe_read_session_digest({ sessionId }) 看你之前在做什么、卡在哪、已交付什么。这是最浓缩的"自己脑子里的活"摘要。\n2. **找当前 feature 文档**：从 session digest 里能抠出 feature ID（F0xx）或关键词，cat_cafe_search_evidence({ query: "<feature ID 或关键词>", scope: "docs", mode: "hybrid" }) 拿真相源（spec / 决策 / lessons）。\n3. **如需更细的工作过程证据**：cat_cafe_read_session_events({ sessionId, limit: 50 }) 看单个 session 内具体调了哪些工具、产生了哪些消息。\n4. 把"我是 Bengal Cat 孟加拉猫，刚被 New Cascade 重启，读了 session chain 最近 X 个 digest，理解了上下文是 ___，正在做的是 ___，准备继续 ___"作为开场白回给铲屎官，让他看到你已经找回记忆。\n这一套约 2-4 次 tool 调用，比让铲屎官手把手 onboard 快得多。所有用到的工具（list_session_chain / read_session_digest / read_session_events / search_evidence）都在 readonly MCP 白名单，无需 callback 凭证、无 UI 审批。\n\n[F061 Bug-F workaround — shell exec via MCP]\n当 Antigravity UI permission gate 拦截 pwd / git 等只读命令时（user denied permission），优先用 MCP 工具 cat_cafe_shell_exec 代替 cascade run_command。cat_cafe_shell_exec 走 MCP stdio，不经 cascade UI gate。**只读命令白名单（严格）**：pwd / ls / cat / git log|status|rev-parse|diff|show。**路径参数必须在 ALLOWED_WORKSPACE_DIRS 范围内**（和 file-tools 同边界）。**默认 cwd 自动指向 workspace 根目录**（ALLOWED_WORKSPACE_DIRS 第一项），所以**不传 cwd 参数也能直接跑**——例如 cat_cafe_shell_exec({ commandLine: "git log --oneline -3" }) 立即返回结果，无需手动指定 cwd。**不在 whitelist 的工具**（curl / mkdir / git worktree / git checkout / npm install 等）不要走 cat_cafe_shell_exec；请走 cascade run_command。Cat Cafe 会对 run_command 做 YOLO native execution + tool-result writeback（仍硬拒绝 Redis 6399、recursive root delete、fork bomb 等危险命令），不依赖铲屎官在 Antigravity UI 点 approval。注意：thread-context / post-message / instructions 这些 HTTP callback 仍必须用 curl via cascade run_command，不走 cat_cafe_shell_exec。`;
}

export interface AntigravityAgentServiceOptions {
  catId?: CatId;
  model?: string;
  /** Manual connection (env vars or explicit config) */
  connection?: Partial<BridgeConnection>;
  /** Inject bridge for testing */
  bridge?: AntigravityBridge;
  /** Idle stall timeout in ms — resets on each new step (default: 60s) */
  pollTimeoutMs?: number;
  /** Auto-approve pending Antigravity interactions — YOLO mode (default: true) */
  autoApprove?: boolean;
  /** Auto-resume eligible post-interruption cascades by effect tier; starts enabled. */
  autoResume?: boolean;
  /** Same original invocation auto-resume cap; starts at one attempt. */
  autoResumeMaxAttempts?: number;
  /** Grace window for buffered recoverable stream_error before surfacing it (default: 4500ms) */
  streamErrorGraceWindowMs?: number;
  /** Capacity retry backoff schedule in ms (default: ~120s total budget). Empty = disabled. */
  modelCapacityRetryDelaysMs?: readonly number[];
  /** F201 Phase F: durable supervisor record store */
  supervisorStore?: AntigravitySupervisorStore;
}

export class AntigravityAgentService implements AgentService {
  readonly catId: CatId;
  private readonly model: string;
  private readonly bridge: AntigravityBridge;
  private readonly pollTimeoutMs: number;
  private readonly autoApprove: boolean;
  private readonly autoResume: boolean;
  private readonly autoResumeMaxAttempts: number;
  private readonly streamErrorGraceWindowMs: number;
  private readonly modelCapacityRetryDelaysMs: number[];
  private readonly supervisorStore: AntigravitySupervisorStore;

  constructor(options?: AntigravityAgentServiceOptions) {
    this.catId = options?.catId
      ? typeof options.catId === 'string'
        ? createCatId(options.catId)
        : options.catId
      : createCatId('antigravity');
    this.model = options?.model ?? getCatModel(this.catId as string);
    const injectedBridge = options?.bridge;
    this.bridge = injectedBridge ?? new AntigravityBridge(options?.connection);
    this.pollTimeoutMs = options?.pollTimeoutMs ?? 60_000;
    let autoApprove = process.env.ANTIGRAVITY_AUTO_APPROVE !== 'false';
    if (options?.autoApprove !== undefined) autoApprove = options.autoApprove;
    this.autoApprove = autoApprove;
    let autoResume = process.env.ANTIGRAVITY_AUTO_RESUME !== 'false';
    if (options?.autoResume !== undefined) autoResume = options.autoResume;
    this.autoResume = autoResume;
    this.autoResumeMaxAttempts = sanitizeAutoResumeMaxAttempts(options?.autoResumeMaxAttempts);
    this.streamErrorGraceWindowMs = options?.streamErrorGraceWindowMs ?? STREAM_ERROR_GRACE_WINDOW_MS;
    this.modelCapacityRetryDelaysMs = sanitizeRetryDelays(options?.modelCapacityRetryDelaysMs);
    this.supervisorStore =
      options?.supervisorStore !== undefined
        ? options.supervisorStore
        : new InMemoryAntigravitySupervisorStore({ auditDir: join(process.cwd(), 'data', 'antigravity-audit') });

    // F061 Phase 2c: auto-attach default native executors when the service owns its bridge.
    // Tests that inject a mock bridge opt out here; they stub nativeExecuteAndPush directly.
    if (!injectedBridge) {
      const registry = new ExecutorRegistry();
      registry.register(
        new RunCommandExecutor({
          rpc: (method, payload, options) => this.bridge.callRpc(method, payload, options),
        }),
      );
      registry.register(new CallMcpToolExecutor());
      for (const toolName of ANTIGRAVITY_IDE_READ_TOOL_NAMES) {
        registry.register(new AntigravityIdeReadToolExecutor(toolName));
      }
      const audit = new AuditLogger(join(process.cwd(), 'data', 'antigravity-audit'));
      this.bridge.attachExecutors(registry, audit);
    }
  }

  async *invoke(prompt: string, options?: AgentServiceOptions): AsyncIterable<AgentMessage> {
    const metadata: MessageMetadata = {
      provider: 'antigravity',
      model: this.model,
      modelVerified: !!this.bridge.resolveModelId(this.model),
    };
    let flushSideEffectJournalAudit = async () => {};

    try {
      // Abort check
      if (options?.signal?.aborted) {
        yield { type: 'error', catId: this.catId, error: 'Aborted before start', metadata, timestamp: Date.now() };
        yield { type: 'done', catId: this.catId, metadata, timestamp: Date.now() };
        return;
      }

      // Antigravity LS validates file paths against its workspace root.
      // Without this hint, the model generates absolute paths that LS rejects.
      // Sanitize path to prevent control-character prompt injection.
      const sanitizedDir = options?.workingDirectory?.split(/[\n\r\x00-\x1f]/)[0]?.trim() ?? '';
      const workspaceHint = sanitizedDir
        ? `\n[Workspace: ${sanitizedDir}]\nAll file paths must be relative to this workspace root. Do not use absolute paths.`
        : '';
      const callbackFallback = buildCallbackFallbackInstructions(options?.callbackEnv);
      const imagePaths = extractImagePaths(options?.contentBlocks, options?.uploadDir);
      const promptBody = appendLocalImagePathHints(prompt, imagePaths);

      const effectivePrompt = options?.systemPrompt
        ? `${options.systemPrompt}${workspaceHint}${callbackFallback}\n\n---\n\n${promptBody}`
        : workspaceHint || callbackFallback
          ? `${`${workspaceHint}${callbackFallback}`.trimStart()}\n\n---\n\n${promptBody}`
          : promptBody;

      const threadId = options?.auditContext?.threadId ?? `ephemeral-${Date.now()}`;
      let cascadeId = await this.bridge.getOrCreateSession(threadId, this.catId as string);
      const createSideEffectJournal = (journalCascadeId: string) =>
        new AntigravitySideEffectJournal({
          threadId,
          catId: this.catId as string,
          cascadeId: journalCascadeId,
          ...(options?.auditContext?.invocationId ? { invocationId: options.auditContext.invocationId } : {}),
          auditDir: join(process.cwd(), 'data', 'antigravity-audit'),
        });
      let sideEffectJournal = createSideEffectJournal(cascadeId);
      flushSideEffectJournalAudit = async () => {
        try {
          await sideEffectJournal.flushAudit();
        } catch (err) {
          log.warn({ cascadeId, err }, 'Antigravity side-effect journal audit write failed');
        }
      };
      let originalInvocationId = cascadeId;
      if (options?.callbackEnv?.CAT_CAFE_INVOCATION_ID) {
        originalInvocationId = options.callbackEnv.CAT_CAFE_INVOCATION_ID;
      }
      if (options?.invocationId) {
        originalInvocationId = options.invocationId;
      }
      if (options?.auditContext?.invocationId) {
        originalInvocationId = options.auditContext.invocationId;
      }
      let autoResumeAttemptCount = 0;
      const persistSupervisor = async (update: {
        status: AntigravitySupervisorStatus;
        recoveryStrategy: AntigravitySupervisorRecoveryStrategy;
        lastObservedStepCount?: number;
        lastDeliveredStepIndex?: number;
        lastTrajectoryAt?: number;
        lastLivenessEvidence?: AntigravityLivenessEvidence;
        nativeExecutorEvidence?: AntigravityNativeExecutorEvidence;
        receiptState?: AntigravitySupervisorReceiptState;
        resumeAttemptCount?: number;
        auditType?: string;
      }) => {
        try {
          const now = Date.now();
          const existing = await this.supervisorStore.get(originalInvocationId, cascadeId);
          const lastTrajectoryAt =
            update.lastTrajectoryAt !== undefined ? update.lastTrajectoryAt : existing?.lastTrajectoryAt;
          const lastLivenessEvidence =
            update.lastLivenessEvidence !== undefined ? update.lastLivenessEvidence : existing?.lastLivenessEvidence;
          const nativeExecutorEvidence =
            update.nativeExecutorEvidence !== undefined
              ? update.nativeExecutorEvidence
              : existing?.nativeExecutorEvidence;
          let lastObservedStepCount = 0;
          if (update.lastDeliveredStepIndex !== undefined) lastObservedStepCount = update.lastDeliveredStepIndex;
          if (existing?.lastObservedStepCount !== undefined) lastObservedStepCount = existing.lastObservedStepCount;
          if (update.lastObservedStepCount !== undefined) lastObservedStepCount = update.lastObservedStepCount;
          let lastDeliveredStepIndex = 0;
          if (update.lastObservedStepCount !== undefined) lastDeliveredStepIndex = update.lastObservedStepCount;
          if (existing?.lastDeliveredStepIndex !== undefined) lastDeliveredStepIndex = existing.lastDeliveredStepIndex;
          if (update.lastDeliveredStepIndex !== undefined) lastDeliveredStepIndex = update.lastDeliveredStepIndex;
          let receiptState: AntigravitySupervisorReceiptState = 'clean';
          if (existing?.receiptState !== undefined) receiptState = existing.receiptState;
          if (update.receiptState !== undefined) receiptState = update.receiptState;
          let resumeAttemptCount = autoResumeAttemptCount;
          if (existing?.resumeAttemptCount !== undefined) resumeAttemptCount = existing.resumeAttemptCount;
          if (update.resumeAttemptCount !== undefined) resumeAttemptCount = update.resumeAttemptCount;
          const createdAt = existing?.createdAt !== undefined ? existing.createdAt : now;
          const auditType = update.auditType !== undefined ? update.auditType : 'supervisor_upsert';
          const record = {
            schemaVersion: 1 as const,
            originalInvocationId,
            threadId,
            catId: this.catId as string,
            cascadeId,
            status: update.status,
            lastObservedStepCount,
            lastDeliveredStepIndex,
            ...(lastTrajectoryAt === undefined ? {} : { lastTrajectoryAt }),
            ...(lastLivenessEvidence === undefined ? {} : { lastLivenessEvidence }),
            ...(nativeExecutorEvidence === undefined ? {} : { nativeExecutorEvidence }),
            journalSummarySnapshot: sideEffectJournal.summary(),
            receiptState,
            recoveryStrategy: update.recoveryStrategy,
            resumeAttemptCount,
            createdAt,
            updatedAt: now,
          };
          const persisted = await this.supervisorStore.upsert(record);
          await this.supervisorStore.appendAudit({ type: auditType, record: persisted });
        } catch (err) {
          log.warn({ cascadeId, err }, 'Antigravity supervisor persistence failed; continuing invocation');
        }
      };
      let preflightCascadeRetirement:
        | { oldCascadeId: string; newCascadeId: string; health: AntigravityCascadeHealthSnapshot }
        | undefined;
      const getCascadeHealth = async (
        targetCascadeId: string,
        lookupStage: 'preflight' | 'empty_response',
      ): Promise<AntigravityCascadeHealthSnapshot | undefined> => {
        if (typeof this.bridge.getCascadeHealth !== 'function') return undefined;
        return this.bridge.getCascadeHealth(targetCascadeId).then(
          (cascadeHealth) => cascadeHealth,
          (err) => {
            log.warn(
              { cascadeId: targetCascadeId, err, lookupStage },
              'Antigravity cascade health lookup failed; continuing with existing cascade',
            );
            return undefined;
          },
        );
      };
      const preflightCascadeHealth = await getCascadeHealth(cascadeId, 'preflight');
      const shouldRetirePreflightCascade =
        preflightCascadeHealth?.level === 'retire' && preflightCascadeHealth.retryableForEmptyResponse;
      if (shouldRetirePreflightCascade) {
        const oldCascadeId = cascadeId;
        this.bridge.resetSession(threadId, this.catId as string);
        cascadeId = await this.bridge.getOrCreateSession(threadId, this.catId as string);
        sideEffectJournal = createSideEffectJournal(cascadeId);
        preflightCascadeRetirement = { oldCascadeId, newCascadeId: cascadeId, health: preflightCascadeHealth };
        log.info(
          { oldCascadeId, newCascadeId: cascadeId, cascadeHealth: preflightCascadeHealth },
          'retired oversized Antigravity cascade',
        );
      } else if (preflightCascadeHealth?.level === 'retire') {
        log.warn(
          { cascadeId, cascadeHealth: preflightCascadeHealth },
          'skipped preflight Antigravity cascade retirement due to side-effect safety',
        );
      }
      let capacityRetryCount = 0;
      let pendingTextReplace = false;
      let promptForCurrentCascade = effectivePrompt;

      const makeSessionInit = (sessionId: string): AgentMessage => ({
        type: 'session_init',
        catId: this.catId,
        sessionId,
        ephemeralSession: true,
        metadata,
        timestamp: Date.now(),
      });

      const classifyResumeTier = (journalSummary = sideEffectJournal.summary()): AntigravityResumeTierDecision =>
        classifyAntigravityResumeTier({
          journalSummary,
          probes: buildAntigravityResumeProbes({
            journalSummary,
            workingDirectory: sanitizedDir,
          }),
        });

      log.info(`invoke: cascade=${cascadeId}, thread=${threadId}, model=${this.model}`);
      yield makeSessionInit(cascadeId);
      if (preflightCascadeRetirement) {
        yield {
          type: 'system_info' as const,
          catId: this.catId,
          content: JSON.stringify({
            type: 'antigravity_cascade_health',
            action: 'retired',
            oldCascadeId: preflightCascadeRetirement.oldCascadeId,
            newCascadeId: preflightCascadeRetirement.newCascadeId,
            health: preflightCascadeRetirement.health,
          }),
          metadata,
          timestamp: Date.now(),
        };
      }

      let activeAutoResumePrompt: string | undefined;
      while (true) {
        const stepsBefore = await this.bridge.sendMessage(cascadeId, promptForCurrentCascade, this.model);

        // Abort check after send
        if (options?.signal?.aborted) {
          yield { type: 'error', catId: this.catId, error: 'Aborted after send', metadata, timestamp: Date.now() };
          yield { type: 'done', catId: this.catId, metadata, timestamp: Date.now() };
          return;
        }

        let hasText = false;
        let fatalSeen = false;
        let terminalAbort = false;
        let autoApproveAttempted = false;
        const stallProbeBudget: StallProbeBudget = { attempts: 0, maxAttempts: STALL_PROBE_MAX_ATTEMPTS };
        let lastDelivered = stepsBefore;
        let attemptHasToolActivity = false;
        let attemptHasDispatchedToolResult = false;
        let attemptHasNativeDispatch = false;
        let attemptHasToolishStep = false;
        let attemptHasResolvedToolishStep = false;
        let attemptHasReadOnlyMcpToolActivity = false;
        let attemptHasUnsafeToolishStep = false;
        let modelCapacityRetryDelayMs: number | null = null;
        let retryErrorKind: UpstreamErrorKind | undefined;
        const handledToolCallIds = new Set<string>();
        let pendingStreamError: AgentMessage | null = null;
        let streamErrorGraceDeadline = 0;
        let pendingStreamErrorMetricAttrs: Record<string, string> = {
          [GENAI_SYSTEM]: 'antigravity',
          [GENAI_MODEL]: normalizeModel(this.model),
          [STREAM_ERROR_PATH]: 'partial_text',
        };
        let pendingAutoResumeContext:
          | {
              journalSummary: ReturnType<AntigravitySideEffectJournal['summary']>;
              resumeTierDecision: AntigravityResumeTierDecision;
              resumeAttemptCount?: number;
            }
          | undefined;

        const clearPendingStreamError = (reason: 'recovered' | 'superseded' | 'expired' | 'retried') => {
          if (!pendingStreamError) return;
          if (reason === 'recovered') {
            antigravityStreamErrorRecovered.add(1, pendingStreamErrorMetricAttrs);
          } else if (reason === 'expired') {
            antigravityStreamErrorExpired.add(1, pendingStreamErrorMetricAttrs);
          }
          pendingStreamError = null;
          streamErrorGraceDeadline = 0;
        };
        const captureAutoResumeContext = (decision: AntigravityRecoveryDecision) => {
          if (decision.action !== 'retry_fresh_cascade') return;
          if (!decision.journalSummary) return;
          if (!decision.resumeTierDecision) return;
          if (decision.resumeAttemptCount === undefined) return;
          pendingAutoResumeContext = {
            journalSummary: decision.journalSummary,
            resumeTierDecision: decision.resumeTierDecision,
            resumeAttemptCount: decision.resumeAttemptCount,
          };
        };
        const service = this;
        const retryFreshCascade = async function* (
          delayMs: number,
          retryKind: UpstreamErrorKind | undefined,
          logMessage: string,
        ) {
          if (hasText) {
            pendingTextReplace = true;
            log.info({ cascadeId }, 'hasText before retry — will inject textMode=replace on fresh cascade');
          }
          const autoResumeSource = pendingAutoResumeContext;
          pendingAutoResumeContext = undefined;
          const autoResumeContext = autoResumeSource
            ? buildAntigravityResumeContext({
                cascadeId,
                interruptedAt: Date.now(),
                journalSummary: autoResumeSource.journalSummary,
                resumeTierDecision: autoResumeSource.resumeTierDecision,
              })
            : undefined;
          if (autoResumeSource?.resumeAttemptCount !== undefined) {
            autoResumeAttemptCount = autoResumeSource.resumeAttemptCount;
            await persistSupervisor({
              status: 'auto_resuming',
              recoveryStrategy: 'auto_resume',
              lastObservedStepCount: lastDelivered,
              lastDeliveredStepIndex: lastDelivered,
              resumeAttemptCount: autoResumeAttemptCount,
              auditType: 'supervisor_auto_resume',
            });
          }
          capacityRetryCount += 1;
          yield buildRetrySignal(
            service.catId,
            metadata,
            capacityRetryCount,
            autoResumeContext
              ? Math.max(service.modelCapacityRetryDelaysMs.length, service.autoResumeMaxAttempts)
              : service.modelCapacityRetryDelaysMs.length,
            delayMs,
            retryKind,
          );
          log.info({ cascadeId, threadId, retryCount: capacityRetryCount, delayMs }, logMessage);
          await sleepWithAbort(delayMs, options?.signal);
          service.bridge.resetSession(threadId, service.catId as string);
          cascadeId = await service.bridge.getOrCreateSession(threadId, service.catId as string);
          sideEffectJournal = createSideEffectJournal(cascadeId);
          if (autoResumeContext) {
            activeAutoResumePrompt = buildSafeAutoResumePrompt(effectivePrompt, autoResumeContext);
          }
          promptForCurrentCascade = activeAutoResumePrompt ?? effectivePrompt;
          yield makeSessionInit(cascadeId);
        };
        const buildRecoveryDecisionDiagnostics = (decision: AntigravityRecoveryDecision | undefined) => {
          if (!decision) return {};
          const recoveryDecision = { action: decision.action, reason: decision.reason };
          if (decision.action !== 'surface_resumable_error') {
            return { recoveryDecision };
          }
          let resumeTierDecision = decision.resumeTierDecision;
          if (resumeTierDecision === undefined) resumeTierDecision = classifyResumeTier(decision.journalSummary);
          return {
            recoveryDecision,
            resumeContext: buildAntigravityResumeContext({
              cascadeId,
              interruptedAt: Date.now(),
              journalSummary: decision.journalSummary,
              resumeTierDecision,
            }),
          };
        };
        const decideBufferedStreamErrorRecovery = () => {
          const journalSummary = sideEffectJournal.summary();
          return decideAntigravityRecovery({
            errorCode: 'stream_error',
            journalSummary,
            retryBudget: {
              attemptsUsed: capacityRetryCount,
              delaysMs: this.modelCapacityRetryDelaysMs,
            },
            dispatchState: {
              hasDispatchRelevantStep: attemptHasToolishStep,
              hasResolvedToolishStep: attemptHasResolvedToolishStep,
              hasNativeDispatch: attemptHasNativeDispatch,
              hasAttemptToolActivity: attemptHasToolActivity,
              hasBatchToolActivity: false,
              toolishRetryEligible: false,
              dispatchRelevantStepKind: attemptHasToolishStep ? 'unknown' : 'none',
            },
            resumeTierDecision: classifyResumeTier(journalSummary),
            autoResumeEnabled: this.autoResume,
            resumeAttemptCount: autoResumeAttemptCount,
            maxAutoResumeAttempts: this.autoResumeMaxAttempts,
          });
        };
        const withRecoveryDiagnostics = (msg: AgentMessage, decision: AntigravityRecoveryDecision): AgentMessage => {
          const baseMetadata = msg.metadata ?? metadata;
          return {
            ...msg,
            metadata: {
              ...baseMetadata,
              diagnostics: {
                ...baseMetadata.diagnostics,
                sideEffectJournal: sideEffectJournal.summary(),
                ...buildRecoveryDecisionDiagnostics(decision),
              },
            },
          };
        };
        const withRecoveryMessages = (msg: AgentMessage, decision: AntigravityRecoveryDecision): AgentMessage[] => {
          const enriched = withRecoveryDiagnostics(msg, decision);
          const recoveryCard = buildAntigravityRecoveryCardMessage({
            catId: this.catId,
            metadata: enriched.metadata ?? metadata,
            recoveryDecision: decision,
            resumeContext: enriched.metadata?.diagnostics?.resumeContext as AntigravityResumeContext | undefined,
            error: enriched.error,
            errorCode: enriched.errorCode,
          });
          return recoveryCard ? [recoveryCard, enriched] : [enriched];
        };
        const persistRecoverySupervisor = async (
          decision: AntigravityRecoveryDecision,
          options: { receiptState: AntigravitySupervisorReceiptState; auditType: string } = {
            receiptState: 'clean',
            auditType: 'supervisor_resumable',
          },
        ) => {
          if (decision.action !== 'surface_resumable_error') return false;
          await persistSupervisor({
            status: 'resumable',
            recoveryStrategy: 'manual_card',
            lastObservedStepCount: lastDelivered,
            lastDeliveredStepIndex: lastDelivered,
            receiptState: options.receiptState,
            auditType: options.auditType,
          });
          return true;
        };

        await persistSupervisor({
          status: 'running',
          recoveryStrategy: 'wait',
          lastObservedStepCount: stepsBefore,
          lastDeliveredStepIndex: lastDelivered,
          auditType: 'supervisor_started',
        });

        // F172 Phase C: collect image file paths from tool results
        const collectedImagePaths = new Set<string>();
        // F172 Phase G: accumulate raw DONE GENERATE_IMAGE steps so the brain
        // scanner can resolve <imageName>_<unixMs>.<ext> in
        // ~/.gemini/antigravity/brain/<cascadeId>/ before yielding `done`.
        const collectedGenerateImageSteps: TrajectoryStep[] = [];

        // Diagnostic counters for empty_response observability
        let totalStepsSeen = 0;
        const rawStepTypeCounts: Record<string, number> = {};
        const transformedMessageTypeCounts: Record<string, number> = {};
        let lastBatchStepTypes: string[] = [];
        const seenUnknownKeys = new Set<string>();
        const pollOnce = async function* (self: AntigravityAgentService, fromStep: number) {
          const iterator = self.bridge
            .pollForSteps(cascadeId, fromStep, self.pollTimeoutMs, 2_000, options?.signal)
            [Symbol.asyncIterator]();

          while (true) {
            let nextBatch: Awaited<ReturnType<typeof iterator.next>>;
            if (pendingStreamError) {
              const remainingMs = streamErrorGraceDeadline - Date.now();
              if (remainingMs <= 0) {
                const streamDecision = decideBufferedStreamErrorRecovery();
                if (streamDecision.action === 'retry_fresh_cascade') {
                  log.info({ cascadeId }, 'stream_error grace expired — entering retry path');
                  modelCapacityRetryDelayMs = streamDecision.delayMs;
                  retryErrorKind = 'stream_interrupted';
                  captureAutoResumeContext(streamDecision);
                  clearPendingStreamError('retried');
                } else {
                  log.warn({ cascadeId }, 'stream_error grace expired without recovery');
                  await persistRecoverySupervisor(streamDecision);
                  for (const recoveryMsg of withRecoveryMessages(pendingStreamError, streamDecision)) {
                    yield recoveryMsg;
                  }
                  clearPendingStreamError('expired');
                  terminalAbort = true;
                }
                try {
                  await iterator.return?.(undefined);
                } catch {
                  // best-effort cleanup only
                }
                return;
              }

              let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
              const raced = await Promise.race([
                iterator.next(),
                new Promise<'__grace_timeout__'>((resolve) => {
                  timeoutHandle = setTimeout(() => resolve('__grace_timeout__'), remainingMs);
                }),
              ]);
              if (timeoutHandle) clearTimeout(timeoutHandle);
              if (raced === '__grace_timeout__') {
                const streamDecision = decideBufferedStreamErrorRecovery();
                if (streamDecision.action === 'retry_fresh_cascade') {
                  log.info({ cascadeId }, 'stream_error grace expired — entering retry path');
                  modelCapacityRetryDelayMs = streamDecision.delayMs;
                  retryErrorKind = 'stream_interrupted';
                  captureAutoResumeContext(streamDecision);
                  clearPendingStreamError('retried');
                } else {
                  log.warn({ cascadeId }, 'stream_error grace expired without recovery');
                  await persistRecoverySupervisor(streamDecision);
                  for (const recoveryMsg of withRecoveryMessages(pendingStreamError, streamDecision)) {
                    yield recoveryMsg;
                  }
                  clearPendingStreamError('expired');
                  terminalAbort = true;
                }
                try {
                  await iterator.return?.(undefined);
                } catch {
                  // best-effort cleanup only
                }
                return;
              }
              nextBatch = raced;
            } else {
              nextBatch = await iterator.next();
            }

            if (nextBatch.done) return;
            const batch = nextBatch.value;
            const persistCursorLiveness = async (evidence: AntigravityLivenessEvidence | undefined) => {
              if (!evidence) return;
              await persistSupervisor({
                status: 'running',
                recoveryStrategy: 'wait',
                lastObservedStepCount: batch.cursor.lastDeliveredStepCount,
                lastDeliveredStepIndex: batch.cursor.lastDeliveredStepCount,
                ...(batch.cursor.lastTrajectoryAt === undefined
                  ? {}
                  : { lastTrajectoryAt: batch.cursor.lastTrajectoryAt }),
                lastLivenessEvidence: evidence,
                auditType: 'supervisor_liveness',
              });
            };
            if (batch.steps.length === 0 && batch.cursor.livenessEvidence && !batch.cursor.awaitingUserInput) {
              await persistCursorLiveness(batch.cursor.livenessEvidence);
              continue;
            }
            if (batch.cursor.awaitingUserInput) {
              const approvalLivenessEvidence =
                batch.cursor.livenessEvidence !== undefined
                  ? batch.cursor.livenessEvidence
                  : {
                      kind: 'pending_approval' as const,
                      observedAt: Date.now(),
                      summary: 'trajectory is awaiting user approval',
                    };
              await persistCursorLiveness(approvalLivenessEvidence);
              if (self.autoApprove && !autoApproveAttempted) {
                autoApproveAttempted = true;
                try {
                  await self.bridge.resolveOutstandingSteps(cascadeId);
                  log.info(`auto-approved pending interaction for cascade ${cascadeId}`);
                  continue;
                } catch (err) {
                  log.warn(`auto-approve failed: ${err}`);
                }
              }
              yield {
                type: 'liveness_signal' as const,
                catId: self.catId,
                content: JSON.stringify({ type: 'info', message: 'Antigravity 正在等待权限批准' }),
                metadata,
                errorCode: 'waiting_approval',
                timestamp: Date.now(),
              };
              continue;
            }
            if (batch.steps.length > 0) {
              const previousLastDelivered = lastDelivered;
              const nextLastDelivered = batch.cursor.lastDeliveredStepCount;
              const deliveryAdvanced = nextLastDelivered > previousLastDelivered;
              if (deliveryAdvanced) {
                autoApproveAttempted = false;
                stallProbeBudget.attempts = 0;
              }
              lastDelivered = nextLastDelivered;

              totalStepsSeen += batch.steps.length;
              lastBatchStepTypes = batch.steps.map((s) => s.type);
              for (const step of batch.steps) {
                rawStepTypeCounts[step.type] = (rawStepTypeCounts[step.type] ?? 0) + 1;
                const unknownKey = `${step.type}:${step.status}`;
                if (classifyStep(step) === 'unknown_activity' && !seenUnknownKeys.has(unknownKey)) {
                  seenUnknownKeys.add(unknownKey);
                  log.info('unknown step type %s (status=%s) in cascade %s', step.type, step.status, cascadeId);
                }
              }

              const messages = transformTrajectorySteps(batch.steps, self.catId, metadata);
              for (const p of collectImagePathsFromSteps(batch.steps)) collectedImagePaths.add(p);
              // F172 Phase G: capture DONE GENERATE_IMAGE steps for the post-invocation brain scan
              for (const step of batch.steps) {
                if (step.type === 'CORTEX_STEP_TYPE_GENERATE_IMAGE' && step.status === 'CORTEX_STEP_STATUS_DONE') {
                  collectedGenerateImageSteps.push(step);
                }
              }
              const batchHasToolActivity = messages.some(
                (msg) => msg.type === 'tool_use' || msg.type === 'tool_result',
              );
              const stepEffects = new Map(
                batch.steps.map((step) => [step, classifyAntigravityStepEffect(step)] as const),
              );
              for (const [index, step] of batch.steps.entries()) {
                const effect = stepEffects.get(step);
                if (!effect) continue;
                sideEffectJournal.observeStep({
                  step,
                  stepIndex: step.metadata?.sourceTrajectoryStepInfo?.stepIndex ?? previousLastDelivered + index,
                  effect,
                });
              }
              const effectForStep = (step: (typeof batch.steps)[number]) => stepEffects.get(step);
              const batchEffectSummary = summarizeAntigravityEffects([...stepEffects.values()]);
              const batchToolishEffects = [...stepEffects.values()].filter(
                (effect) => effect.blocksBlindRetry || effect.kind === 'tool_read',
              );
              const isRetrySafeReadOnlyMcpEffect = (effect: (typeof batchToolishEffects)[number]) =>
                effect.kind === 'tool_read' &&
                effect.effectType === 'mcp' &&
                !effect.sideEffectCapable &&
                !effect.blocksBlindRetry;
              const batchHasReadOnlyMcpToolActivity =
                batchToolishEffects.length > 0 && batchToolishEffects.every(isRetrySafeReadOnlyMcpEffect);
              const batchHasUnsafeToolishStep =
                batchToolishEffects.length > 0 &&
                batchToolishEffects.some((effect) => !isRetrySafeReadOnlyMcpEffect(effect));
              const isF201ToolishStep = (step: (typeof batch.steps)[number]) => {
                const effect = effectForStep(step);
                return effect?.blocksBlindRetry === true || effect?.kind === 'tool_read';
              };
              const isResolvedF201ToolishStep = (step: (typeof batch.steps)[number]) => {
                if (step.type === 'CORTEX_STEP_TYPE_RUN_COMMAND') {
                  return step.status !== 'CORTEX_STEP_STATUS_WAITING' && step.status !== 'CORTEX_STEP_STATUS_ERROR';
                }
                const effect = effectForStep(step);
                if (!effect) return false;
                if (effect.completedSideEffect) return true;
                if (effect.failedSideEffect) return true;
                if (!effect.blocksBlindRetry) return false;
                return step.status !== 'CORTEX_STEP_STATUS_WAITING' && step.status !== 'CORTEX_STEP_STATUS_ERROR';
              };
              const batchHasDispatchRelevantStep = batch.steps.some(isF201ToolishStep);
              const batchHasUpstreamError = messages.some(
                (msg) => msg.type === 'error' && msg.errorCode === 'upstream_error',
              );
              const batchHasModelCapacity = messages.some(
                (msg) => msg.type === 'error' && msg.errorCode === 'model_capacity',
              );
              const batchHasNetworkError = messages.some(
                (msg) => msg.type === 'error' && msg.errorCode === 'network_error',
              );
              const batchHasTransientError = batchHasModelCapacity || batchHasNetworkError;
              const getToolishToolName = (step: (typeof batch.steps)[number] | undefined) =>
                step?.metadata?.toolCall?.name ?? step?.toolCall?.toolName ?? step?.toolResult?.toolName;
              const stepIndexFor = (step: (typeof batch.steps)[number]) => {
                const sourceStepIndex = step.metadata?.sourceTrajectoryStepInfo?.stepIndex;
                if (sourceStepIndex !== undefined) return sourceStepIndex;
                return previousLastDelivered + batch.steps.indexOf(step);
              };
              const firstToolishStep = batch.steps.find(isF201ToolishStep);
              const allBatchToolishStepCount = batch.steps.filter(isF201ToolishStep).length;
              const batchHasResolvedToolishStep = batch.steps.some((step) => {
                const isToolish = isF201ToolishStep(step);
                if (!isToolish) return false;
                return isResolvedF201ToolishStep(step);
              });
              const waitingToolishSteps = batch.steps.filter((step) => step.status === 'CORTEX_STEP_STATUS_WAITING');
              const blockingToolishStep = waitingToolishSteps[0] ?? firstToolishStep;
              const blockingStepIsRunCommand = blockingToolishStep?.type === 'CORTEX_STEP_TYPE_RUN_COMMAND';
              const approvalDiagnosticSteps = batch.steps.filter(
                (step) =>
                  step.type === 'CORTEX_STEP_TYPE_RUN_COMMAND' &&
                  (step.status === 'CORTEX_STEP_STATUS_WAITING' || step.status === 'CORTEX_STEP_STATUS_ERROR'),
              );
              const approvalDiagnosticStep =
                allBatchToolishStepCount === 1 && approvalDiagnosticSteps.length === 1
                  ? approvalDiagnosticSteps[0]
                  : undefined;
              const toolishToolName =
                getToolishToolName(blockingToolishStep) ?? (blockingStepIsRunCommand ? 'run_command' : undefined);
              const approvalDiagnosticToolName =
                getToolishToolName(approvalDiagnosticStep) ??
                (approvalDiagnosticStep?.type === 'CORTEX_STEP_TYPE_RUN_COMMAND' ? 'run_command' : undefined);
              let toolishCommandLine: string | undefined;
              let toolishSafeToAutoRun = false;
              if (blockingStepIsRunCommand) {
                try {
                  const args = JSON.parse(blockingToolishStep?.metadata?.toolCall?.argumentsJson ?? '{}') as Record<
                    string,
                    unknown
                  >;
                  toolishSafeToAutoRun = args.SafeToAutoRun === true;
                  toolishCommandLine = (
                    (args.CommandLine as string | undefined) ?? (args.commandLine as string | undefined)
                  )?.trim();
                } catch {
                  toolishSafeToAutoRun = false;
                  toolishCommandLine = undefined;
                }
              }
              // Safe retry only applies when the blocking step is a read-only
              // run_command. Any other waiting tool remains terminal until we
              // can prove dispatch/writeback state more precisely.
              const singleBlockingWaitingRunCommand =
                allBatchToolishStepCount === 1 &&
                !batchEffectSummary.blocksBlindRetry &&
                waitingToolishSteps.length === 1 &&
                blockingStepIsRunCommand &&
                blockingToolishStep?.status === 'CORTEX_STEP_STATUS_WAITING' &&
                true;
              const toolishRetryEligible =
                singleBlockingWaitingRunCommand && toolishSafeToAutoRun && toolishCommandLine
                  ? isReadOnlyRunCommand(toolishCommandLine)
                  : false;
              const dispatchRelevantStepKind = (() => {
                const effect = firstToolishStep ? effectForStep(firstToolishStep) : undefined;
                if (!effect) return 'none';
                if (effect.kind === 'tool_read') {
                  if (effect.effectType === 'mcp') return 'tool_read_mcp';
                  if (effect.effectType === 'shell') return 'tool_read_shell';
                  return 'tool_read';
                }
                if (effect.sideEffectCapable) return 'side_effect';
                if (effect.blocksBlindRetry) return 'side_effect';
                return 'unknown';
              })() satisfies AntigravityDispatchRelevantStepKind;
              const transientJournalSummary = sideEffectJournal.summary();
              const readOnlyToolActivityRetryEligible =
                (attemptHasReadOnlyMcpToolActivity || batchHasReadOnlyMcpToolActivity) &&
                !attemptHasUnsafeToolishStep &&
                !batchHasUnsafeToolishStep &&
                !attemptHasNativeDispatch &&
                !transientJournalSummary.blocksBlindRetry;
              const transientRecoveryDecision = batchHasTransientError
                ? decideAntigravityRecovery({
                    errorCode: batchHasModelCapacity ? 'model_capacity' : 'network_error',
                    journalSummary: transientJournalSummary,
                    retryBudget: {
                      attemptsUsed: capacityRetryCount,
                      delaysMs: self.modelCapacityRetryDelaysMs,
                    },
                    dispatchState: {
                      hasDispatchRelevantStep: batchHasDispatchRelevantStep,
                      hasResolvedToolishStep: batchHasResolvedToolishStep ? true : attemptHasResolvedToolishStep,
                      hasNativeDispatch: attemptHasNativeDispatch,
                      hasAttemptToolActivity: attemptHasToolActivity,
                      hasBatchToolActivity: batchHasToolActivity,
                      toolishRetryEligible,
                      readOnlyToolActivityRetryEligible,
                      dispatchRelevantStepKind,
                      hasCooccurringUpstreamError: batchHasUpstreamError,
                    },
                    resumeTierDecision: classifyResumeTier(transientJournalSummary),
                    autoResumeEnabled: self.autoResume,
                    resumeAttemptCount: autoResumeAttemptCount,
                    maxAutoResumeAttempts: self.autoResumeMaxAttempts,
                  })
                : undefined;
              const buildBeforeDispatchDiagnostics = (failureLayer: string, extra: Record<string, unknown> = {}) => ({
                failureLayer,
                dispatchState:
                  batchHasResolvedToolishStep ||
                  attemptHasResolvedToolishStep ||
                  attemptHasNativeDispatch ||
                  attemptHasDispatchedToolResult
                    ? 'after_dispatch'
                    : batchHasDispatchRelevantStep || waitingToolishSteps.length > 0
                      ? 'before_dispatch'
                      : 'unknown',
                toolishStepType: blockingToolishStep?.type,
                toolishToolName,
                executionJournal: sideEffectJournal.toExecutionJournal({
                  approvalSent: false,
                  dispatchAttempted:
                    batchHasResolvedToolishStep ||
                    attemptHasResolvedToolishStep ||
                    attemptHasNativeDispatch ||
                    attemptHasDispatchedToolResult,
                  dispatchReturned:
                    batchHasResolvedToolishStep ||
                    attemptHasResolvedToolishStep ||
                    attemptHasNativeDispatch ||
                    attemptHasDispatchedToolResult,
                  writebackSent:
                    batchHasResolvedToolishStep ||
                    attemptHasResolvedToolishStep ||
                    attemptHasNativeDispatch ||
                    attemptHasDispatchedToolResult,
                }),
                sideEffectJournal: sideEffectJournal.summary(),
                sideEffectSummary: {
                  hasUnsafeSideEffect: batchEffectSummary.hasUnsafeSideEffect,
                  hasCompletedSideEffect: batchEffectSummary.hasCompletedSideEffect,
                  hasFailedSideEffect: batchEffectSummary.hasFailedSideEffect,
                  blocksBlindRetry: batchEffectSummary.blocksBlindRetry,
                  effects: batchEffectSummary.effects.map((effect) => ({
                    kind: effect.kind,
                    effectType: effect.effectType,
                    toolName: effect.toolName,
                    target: effect.target,
                    reason: effect.reason,
                  })),
                },
                toolishRetryEligible,
                ...extra,
              });
              const willRetryFreshCascade = transientRecoveryDecision?.action === 'retry_fresh_cascade';
              const pendingToolLivenessEvidence = (() => {
                const pendingStep = waitingToolishSteps[0];
                if (!pendingStep) return undefined;
                const pendingToolishName = getToolishToolName(pendingStep);
                const pendingToolName = pendingToolishName !== undefined ? pendingToolishName : pendingStep.type;
                return {
                  kind: 'pending_tool' as const,
                  observedAt: Date.now(),
                  summary: `waiting tool step ${pendingToolName} is pending native handling`,
                };
              })();
              const batchLivenessEvidence =
                pendingToolLivenessEvidence !== undefined ? pendingToolLivenessEvidence : batch.cursor.livenessEvidence;

              const batchMsgTypeCounts: Record<string, number> = {};
              for (const msg of messages) {
                transformedMessageTypeCounts[msg.type] = (transformedMessageTypeCounts[msg.type] ?? 0) + 1;
                batchMsgTypeCounts[msg.type] = (batchMsgTypeCounts[msg.type] ?? 0) + 1;
              }
              log.info(
                {
                  cascadeId,
                  batchSize: batch.steps.length,
                  lastDelivered,
                  rawStepTypes: lastBatchStepTypes,
                  msgTypeCounts: batchMsgTypeCounts,
                  totalStepsSeen,
                  willRetryFreshCascade,
                  capacityRetryCount,
                },
                'batch processed',
              );
              if (TRACE_ENABLED) {
                traceLog.info(
                  { cascadeId, stepShapes: batch.steps.map((s) => summarizeStepShape(s)) },
                  'step structure snapshot',
                );
              }
              await persistSupervisor({
                status: 'running',
                recoveryStrategy: 'wait',
                lastObservedStepCount: lastDelivered,
                lastDeliveredStepIndex: lastDelivered,
                ...(batch.cursor.lastTrajectoryAt === undefined
                  ? {}
                  : { lastTrajectoryAt: batch.cursor.lastTrajectoryAt }),
                ...(batchLivenessEvidence === undefined ? {} : { lastLivenessEvidence: batchLivenessEvidence }),
                auditType: batchLivenessEvidence === undefined ? 'supervisor_batch' : 'supervisor_liveness',
              });

              const seenFatalKeys = new Set<string>();
              const batchHasSpecificError = messages.some(
                (msg) =>
                  msg.type === 'error' &&
                  (msg.errorCode === 'upstream_error' ||
                    msg.errorCode === 'model_capacity' ||
                    msg.errorCode === 'network_error'),
              );
              for (const msg of messages) {
                const isFatal = msg.type === 'error' && msg.errorCode && msg.errorCode !== 'tool_error';
                if (!isFatal) {
                  if (willRetryFreshCascade && msg.type === 'provider_signal') {
                    continue;
                  }
                  if (msg.type === 'text') {
                    if (pendingStreamError) {
                      log.info({ cascadeId }, 'stream_error recovered mid-stream');
                      clearPendingStreamError('recovered');
                    }
                    hasText = true;
                    if (pendingTextReplace && msg.content) {
                      log.info({ cascadeId }, 'injecting textMode=replace for fresh cascade after retry');
                      pendingTextReplace = false;
                      yield { ...msg, textMode: 'replace' as const };
                      continue;
                    }
                  }
                  if (msg.type === 'tool_use') attemptHasToolActivity = true;
                  if (msg.type === 'tool_result') {
                    attemptHasToolActivity = true;
                    attemptHasDispatchedToolResult = true;
                  }
                  yield msg;
                  continue;
                }

                const key = `${msg.errorCode}:${msg.error}`;
                if (seenFatalKeys.has(key)) {
                  log.info('suppressed duplicate fatal error in same batch: %s', msg.error);
                  continue;
                }
                seenFatalKeys.add(key);

                if (msg.errorCode === 'stream_error' && batchHasSpecificError) {
                  log.info('suppressed stream_error in favor of upstream_error: %s', msg.error);
                  continue;
                }

                if (msg.errorCode === 'model_capacity' || msg.errorCode === 'network_error') {
                  if (pendingStreamError) {
                    log.info({ cascadeId }, 'stream_error superseded by %s', msg.errorCode);
                    clearPendingStreamError('superseded');
                  }
                  if (transientRecoveryDecision?.action === 'retry_fresh_cascade') {
                    modelCapacityRetryDelayMs = transientRecoveryDecision.delayMs;
                    retryErrorKind = msg.metadata?.upstreamError?.kind as UpstreamErrorKind | undefined;
                    captureAutoResumeContext(transientRecoveryDecision);
                    continue;
                  }
                  fatalSeen = true;
                  terminalAbort = true;
                  const errorMetadata = msg.metadata ?? metadata;
                  await flushSideEffectJournalAudit();
                  // This branch is exactly the ambiguity we are debugging:
                  // the model has surfaced a capacity error, but we also saw a
                  // tool-ish step in the same batch, so automatic retry is
                  // intentionally suppressed until we know whether dispatch ran.
                  const enrichedTransientError = {
                    ...msg,
                    metadata: {
                      ...errorMetadata,
                      diagnostics: {
                        ...errorMetadata.diagnostics,
                        ...buildBeforeDispatchDiagnostics('provider_capacity', {
                          retryEligible: false,
                          ...buildRecoveryDecisionDiagnostics(transientRecoveryDecision),
                          retrySuppressedBy:
                            batchHasResolvedToolishStep || attemptHasResolvedToolishStep
                              ? 'resolved_toolish_step_seen'
                              : attemptHasNativeDispatch
                                ? 'native_dispatch_seen'
                                : attemptHasToolActivity || batchHasToolActivity
                                  ? 'tool_activity_seen'
                                  : batchHasDispatchRelevantStep && !toolishRetryEligible
                                    ? 'toolish_step_present'
                                    : batchHasUpstreamError
                                      ? 'cooccurring_upstream_error'
                                      : capacityRetryCount >= self.modelCapacityRetryDelaysMs.length
                                        ? 'retry_budget_exhausted'
                                        : 'terminal_policy',
                        }),
                        retryEligible: false,
                      },
                    },
                  };
                  if (transientRecoveryDecision?.action === 'surface_resumable_error') {
                    if (await persistRecoverySupervisor(transientRecoveryDecision)) {
                      terminalAbort = true;
                    }
                    for (const recoveryMsg of withRecoveryMessages(enrichedTransientError, transientRecoveryDecision)) {
                      yield recoveryMsg;
                    }
                    continue;
                  }
                  yield enrichedTransientError;
                  continue;
                }

                fatalSeen = true;
                if (msg.errorCode === 'upstream_error') {
                  if (pendingStreamError) {
                    log.info({ cascadeId }, 'stream_error superseded by upstream_error');
                    clearPendingStreamError('superseded');
                  }
                  const errorMetadata = msg.metadata ?? metadata;
                  const rawError = msg.metadata?.upstreamError?.rawReason ?? msg.error ?? '';
                  const looksLikeApprovalDenied = /user denied permission/i.test(rawError);
                  const looksLikeApprovalTimeout = /context canceled/i.test(rawError);
                  if (
                    approvalDiagnosticStep?.type === 'CORTEX_STEP_TYPE_RUN_COMMAND' &&
                    (looksLikeApprovalDenied || looksLikeApprovalTimeout)
                  ) {
                    yield {
                      ...msg,
                      metadata: {
                        ...errorMetadata,
                        diagnostics: {
                          ...errorMetadata.diagnostics,
                          ...buildBeforeDispatchDiagnostics('approval_gate', {
                            approvalState: looksLikeApprovalDenied ? 'denied' : 'timeout',
                            toolishStepType: approvalDiagnosticStep.type,
                            toolishToolName: approvalDiagnosticToolName,
                          }),
                        },
                      },
                    };
                    continue;
                  }
                  if (attemptHasNativeDispatch) {
                    const receiptConflictJournalSummary = sideEffectJournal.summary();
                    const noObservedSideEffect =
                      !receiptConflictJournalSummary.hasSideEffect && !receiptConflictJournalSummary.blocksBlindRetry;
                    if (noObservedSideEffect) {
                      const delayMs = self.modelCapacityRetryDelaysMs[capacityRetryCount];
                      if (delayMs != null) {
                        log.info(
                          { cascadeId, errorCode: msg.errorCode },
                          'native receipt conflict has no observed side effect — entering retry path',
                        );
                        modelCapacityRetryDelayMs = delayMs;
                        retryErrorKind = msg.metadata?.upstreamError?.kind as UpstreamErrorKind | undefined;
                        continue;
                      }
                    }
                    const receiptConflictDecision: AntigravityRecoveryDecision = {
                      action: 'surface_resumable_error',
                      reason: 'receipt_conflict_native_success_trajectory_error',
                      journalSummary: receiptConflictJournalSummary,
                    };
                    if (
                      await persistRecoverySupervisor(receiptConflictDecision, {
                        receiptState: 'native_success_trajectory_error',
                        auditType: 'supervisor_receipt_conflict',
                      })
                    ) {
                      terminalAbort = true;
                    }
                    const receiptConflictError = {
                      ...msg,
                      metadata: {
                        ...errorMetadata,
                        diagnostics: {
                          ...errorMetadata.diagnostics,
                          ...buildBeforeDispatchDiagnostics('receipt_conflict', {
                            receiptConflict: 'native_success_trajectory_error',
                            retryEligible: false,
                            ...buildRecoveryDecisionDiagnostics(receiptConflictDecision),
                          }),
                        },
                      },
                    };
                    for (const recoveryMsg of withRecoveryMessages(receiptConflictError, receiptConflictDecision)) {
                      yield recoveryMsg;
                    }
                    continue;
                  }
                  yield msg;
                  continue;
                }

                if (msg.errorCode === 'stream_error') {
                  pendingStreamErrorMetricAttrs = {
                    [GENAI_SYSTEM]: 'antigravity',
                    [GENAI_MODEL]: normalizeModel(self.model),
                    [STREAM_ERROR_PATH]: hasText ? 'partial_text' : 'no_text',
                  };
                  if (!pendingStreamError) {
                    antigravityStreamErrorBuffered.add(1, pendingStreamErrorMetricAttrs);
                  }
                  pendingStreamError = msg;
                  streamErrorGraceDeadline = Date.now() + self.streamErrorGraceWindowMs;
                  continue;
                }

                terminalAbort = true;
                yield msg;
              }

              if (modelCapacityRetryDelayMs != null) {
                log.info(
                  { cascadeId, delayMs: modelCapacityRetryDelayMs, retryErrorKind },
                  'Antigravity retry requested',
                );
                return;
              }

              if (terminalAbort) break;
              const persistNativeExecutorEvidence = async (
                step: (typeof batch.steps)[number],
                status: AntigravityNativeExecutorEvidence['status'],
              ) => {
                const toolishName = getToolishToolName(step);
                const toolName = toolishName !== undefined ? toolishName : step.type;
                const observedAt = Date.now();
                const summary = `native executor ${status.replace(/_/g, ' ')} ${toolName} step ${stepIndexFor(step)}`;
                const nativeExecutorEvidence: AntigravityNativeExecutorEvidence = {
                  toolName,
                  stepType: step.type,
                  stepIndex: stepIndexFor(step),
                  status,
                  observedAt,
                  summary,
                };
                await persistSupervisor({
                  status: 'running',
                  recoveryStrategy: 'wait',
                  lastObservedStepCount: lastDelivered,
                  lastDeliveredStepIndex: lastDelivered,
                  ...(batch.cursor.lastTrajectoryAt === undefined
                    ? {}
                    : { lastTrajectoryAt: batch.cursor.lastTrajectoryAt }),
                  lastLivenessEvidence: {
                    kind: 'native_executor_active',
                    observedAt,
                    summary,
                  },
                  nativeExecutorEvidence,
                  auditType: 'supervisor_liveness',
                });
              };
              for (const step of batch.steps) {
                const toolCallId = step.metadata?.toolCall?.id;
                if (toolCallId && handledToolCallIds.has(toolCallId)) continue;
                const hasToolCallId = Boolean(toolCallId);
                const isWaitingStep = step.status === 'CORTEX_STEP_STATUS_WAITING';
                const recordNativeExecutor = hasToolCallId ? true : isWaitingStep;
                try {
                  if (recordNativeExecutor) {
                    await persistNativeExecutorEvidence(step, 'started');
                  }
                  const handled = await self.bridge.nativeExecuteAndPush(step, {
                    cascadeId,
                    cwd: sanitizedDir,
                    modelName: self.model,
                  });
                  if (recordNativeExecutor) {
                    const evidenceStatus =
                      handled === true
                        ? 'completed'
                        : handled === 'approval_pending'
                          ? 'approval_pending'
                          : handled === 'no_executor'
                            ? 'no_executor'
                            : 'not_handled';
                    await persistNativeExecutorEvidence(step, evidenceStatus);
                  }
                  if (handled === true) {
                    // Any truthy native step handling means this invoke already
                    // advanced a local tool path, so later capacity errors must
                    // not be treated as safely undispatched.
                    attemptHasNativeDispatch = true;
                  }
                  if (handled === 'approval_pending') {
                    if (self.autoApprove && !autoApproveAttempted) {
                      autoApproveAttempted = true;
                      try {
                        await self.bridge.resolveOutstandingSteps(cascadeId);
                        log.info(`auto-approved pending native tool interaction for cascade ${cascadeId}`);
                        continue;
                      } catch (err) {
                        log.warn(`auto-approve pending native tool interaction failed: ${err}`);
                      }
                    }
                    yield {
                      type: 'liveness_signal' as const,
                      catId: self.catId,
                      content: JSON.stringify({ type: 'info', message: 'Antigravity 正在等待权限批准' }),
                      metadata,
                      errorCode: 'waiting_approval',
                      timestamp: Date.now(),
                    };
                    continue;
                  }
                  if (handled === true && toolCallId) handledToolCallIds.add(toolCallId);
                  if (
                    handled === 'no_executor' &&
                    step.status === 'CORTEX_STEP_STATUS_WAITING' &&
                    !batch.cursor.awaitingUserInput
                  ) {
                    const toolName = step.metadata?.toolCall?.name ?? step.toolCall?.toolName ?? step.type;
                    log.error(
                      { cascadeId, toolName, stepType: step.type, status: step.status },
                      'unsupported waiting tool step would otherwise stall the retry path',
                    );
                    fatalSeen = true;
                    terminalAbort = true;
                    yield {
                      type: 'error' as const,
                      catId: self.catId,
                      error: `Antigravity waiting tool step "${toolName}" is not supported by the current native executor; aborting instead of waiting for stall timeout.`,
                      errorCode: 'unsupported_waiting_tool',
                      metadata,
                      timestamp: Date.now(),
                    };
                    break;
                  }
                } catch (err) {
                  if (recordNativeExecutor) {
                    await persistNativeExecutorEvidence(step, 'error');
                  }
                  log.warn(`nativeExecuteAndPush failed for step: ${err}`);
                }
              }
              if (batchHasDispatchRelevantStep) {
                attemptHasToolishStep = true;
              }
              if (batchHasResolvedToolishStep) {
                attemptHasResolvedToolishStep = true;
              }
              if (batchHasReadOnlyMcpToolActivity) {
                attemptHasReadOnlyMcpToolActivity = true;
              }
              if (batchHasUnsafeToolishStep) {
                attemptHasUnsafeToolishStep = true;
              }
            }
            if (terminalAbort) {
              log.info('terminal error detected (model_capacity/stream_error), aborting poll loop');
              return;
            }
          }
        };

        let retry = true;
        while (retry) {
          retry = false;
          try {
            for await (const msg of pollOnce(this, lastDelivered)) {
              yield msg;
            }
            if (pendingStreamError) {
              const streamDecision = decideBufferedStreamErrorRecovery();
              if (streamDecision.action === 'retry_fresh_cascade') {
                log.info({ cascadeId }, 'stream_error grace expired after poll — entering retry path');
                modelCapacityRetryDelayMs = streamDecision.delayMs;
                retryErrorKind = 'stream_interrupted';
                captureAutoResumeContext(streamDecision);
                clearPendingStreamError('retried');
              } else {
                log.warn({ cascadeId }, 'stream_error grace expired after poll completion without recovery');
                await persistRecoverySupervisor(streamDecision);
                for (const recoveryMsg of withRecoveryMessages(pendingStreamError, streamDecision)) {
                  yield recoveryMsg;
                }
                clearPendingStreamError('expired');
                terminalAbort = true;
              }
            }
          } catch (err) {
            const isStall = err instanceof Error && err.message.includes('stall');
            if (pendingStreamError && isStall) {
              const streamDecision = decideBufferedStreamErrorRecovery();
              if (streamDecision.action === 'retry_fresh_cascade') {
                log.info({ cascadeId }, 'stream_error grace expired on stall — entering retry path');
                modelCapacityRetryDelayMs = streamDecision.delayMs;
                retryErrorKind = 'stream_interrupted';
                captureAutoResumeContext(streamDecision);
                clearPendingStreamError('retried');
              } else {
                log.warn({ cascadeId }, 'stream_error grace expired on stall without recovery');
                await persistRecoverySupervisor(streamDecision);
                for (const recoveryMsg of withRecoveryMessages(pendingStreamError, streamDecision)) {
                  yield recoveryMsg;
                }
                clearPendingStreamError('expired');
                terminalAbort = true;
              }
              break;
            }
            if (isStall) {
              try {
                const existingSupervisor = await this.supervisorStore.get(originalInvocationId, cascadeId);
                const liveness = detectStallLivenessFromTrajectory(
                  await this.bridge.getTrajectory(cascadeId),
                  lastDelivered,
                  existingSupervisor?.lastTrajectoryAt,
                );
                if (liveness) {
                  if (stallProbeBudget.attempts >= stallProbeBudget.maxAttempts) {
                    log.warn(
                      { cascadeId, liveness, lastDelivered, stallProbeBudget },
                      'trajectory-derived liveness exhausted stall probe budget; surfacing stall',
                    );
                  } else {
                    stallProbeBudget.attempts += 1;
                    log.info(
                      { cascadeId, liveness, lastDelivered },
                      'stall ignored because Antigravity trajectory still shows liveness',
                    );
                    await persistSupervisor({
                      status: 'running',
                      recoveryStrategy: 'wait',
                      lastObservedStepCount: liveness.observedSteps,
                      lastDeliveredStepIndex: lastDelivered,
                      lastTrajectoryAt:
                        liveness.kind === 'trajectory_timestamp_progress' ? liveness.trajectoryAt : Date.now(),
                      lastLivenessEvidence: {
                        kind: liveness.kind,
                        observedAt: Date.now(),
                        summary:
                          liveness.kind === 'trajectory_timestamp_progress'
                            ? `trajectory timestamp advanced from ${liveness.previousTrajectoryAt} to ${liveness.trajectoryAt}`
                            : `trajectory step count advanced from ${liveness.lastDelivered} to ${liveness.observedSteps}`,
                      },
                      auditType: 'supervisor_liveness',
                    });
                    retry = true;
                    continue;
                  }
                }
              } catch (livenessErr) {
                log.warn(`stall liveness probe failed: ${livenessErr}`);
              }
            }
            if (isStall && this.autoApprove && stallProbeBudget.attempts < stallProbeBudget.maxAttempts) {
              stallProbeBudget.attempts += 1;
              await persistSupervisor({
                status: 'probing',
                recoveryStrategy: 'probe',
                lastObservedStepCount: lastDelivered,
                lastDeliveredStepIndex: lastDelivered,
                auditType: 'supervisor_probe',
              });
              try {
                await this.bridge.resolveOutstandingSteps(cascadeId);
                log.info(
                  `probe-approved on stall for cascade ${cascadeId}, retrying poll from step ${lastDelivered} (${stallProbeBudget.attempts}/${stallProbeBudget.maxAttempts})`,
                );
                retry = true;
                continue;
              } catch (probeErr) {
                log.warn(`stall probe failed: ${probeErr}`);
              }
            }
            throw err;
          }
          if (terminalAbort || modelCapacityRetryDelayMs != null) break;
        }

        if (modelCapacityRetryDelayMs != null) {
          for await (const retryMsg of retryFreshCascade(
            modelCapacityRetryDelayMs,
            retryErrorKind,
            'retrying Antigravity invoke after transient error',
          )) {
            yield retryMsg;
          }
          continue;
        }

        // F172 Phase H: image-only response is a valid user-visible output —
        // Phase G yields a media_gallery rich block via the brain scanner and
        // Phase F yields one via the toolResult-path publisher (future-proof).
        // empty_response only fires when neither text NOR an image surfaced.
        const sawImageOutput = collectedGenerateImageSteps.length > 0 || collectedImagePaths.size > 0;
        if (!hasText && !fatalSeen && !sawImageOutput) {
          const sideEffectJournalSummary = sideEffectJournal.summary();
          const cascadeHealth = await getCascadeHealth(cascadeId, 'empty_response');
          const emptyResponseRecoveryDecision = decideAntigravityRecovery({
            errorCode: 'empty_response',
            journalSummary: sideEffectJournalSummary,
            retryBudget: {
              attemptsUsed: capacityRetryCount,
              delaysMs: this.modelCapacityRetryDelaysMs,
            },
            dispatchState: {
              hasDispatchRelevantStep: attemptHasToolishStep,
              hasResolvedToolishStep: attemptHasResolvedToolishStep,
              hasNativeDispatch: attemptHasNativeDispatch,
              hasAttemptToolActivity: attemptHasToolActivity,
              hasBatchToolActivity: false,
              toolishRetryEligible: false,
              dispatchRelevantStepKind: attemptHasToolishStep ? 'unknown' : 'none',
            },
            resumeTierDecision: classifyResumeTier(sideEffectJournalSummary),
            autoResumeEnabled: this.autoResume,
            resumeAttemptCount: autoResumeAttemptCount,
            maxAutoResumeAttempts: this.autoResumeMaxAttempts,
            cascadeHealth,
          });
          const diagnostics = {
            totalStepsSeen,
            rawStepTypeCounts,
            transformedMessageTypeCounts,
            lastBatchStepTypes,
            lastDelivered,
            hasText,
            fatalSeen,
            cascadeId,
            cascadeHealth,
            sideEffectJournal: sideEffectJournalSummary,
            sideEffectSummary: {
              hasUnsafeSideEffect: sideEffectJournalSummary.hasUnsafeSideEffect,
              hasCompletedSideEffect: sideEffectJournalSummary.hasCompletedSideEffect,
              hasFailedSideEffect: sideEffectJournalSummary.hasFailedSideEffect,
              blocksBlindRetry: sideEffectJournalSummary.blocksBlindRetry,
              effects: sideEffectJournalSummary.entries.map((entry) => ({
                kind: entry.effectKind,
                effectType: entry.effectType,
                target: entry.target,
                operation: entry.operation,
                status: entry.status,
              })),
            },
            ...buildRecoveryDecisionDiagnostics(emptyResponseRecoveryDecision),
          };
          if (emptyResponseRecoveryDecision.action === 'retry_fresh_cascade') {
            captureAutoResumeContext(emptyResponseRecoveryDecision);
            for await (const retryMsg of retryFreshCascade(
              emptyResponseRecoveryDecision.delayMs,
              'unknown',
              'retrying Antigravity invoke after empty_response on retired cascade',
            )) {
              yield retryMsg;
            }
            continue;
          }
          if (await persistRecoverySupervisor(emptyResponseRecoveryDecision)) {
            terminalAbort = true;
          }
          log.warn(diagnostics, 'empty_response triggered — no text received from Antigravity');
          await flushSideEffectJournalAudit();
          yield {
            type: 'error',
            catId: this.catId,
            error: 'Antigravity returned no text response',
            errorCode: 'empty_response',
            metadata: { ...metadata, diagnostics },
            timestamp: Date.now(),
          };
        }

        // F172 Phase C: publish any images found in tool results (legacy / future-proof path).
        // MUTUALLY EXCLUSIVE with Phase G: when GENERATE_IMAGE steps were observed
        // we trust the brain scanner and skip the legacy path — running both would
        // double-publish the same physical file because the two paths use
        // different publicationKey shapes (Phase F = pathHash+filename,
        // Phase G = filename) and the F172 contract requires a single canonical
        // /uploads/ artifact + media_gallery per image (KD-2 / KD-4).
        if (collectedImagePaths.size > 0 && cascadeId && collectedGenerateImageSteps.length === 0) {
          try {
            const published = await publishAntigravityImages({
              candidatePaths: [...collectedImagePaths],
              cascadeId,
              uploadDir: options?.uploadDir,
            });
            for (const img of published) {
              yield {
                type: 'system_info' as const,
                catId: this.catId,
                content: JSON.stringify({ type: 'rich_block', block: img.richBlock, provenance: img.provenance }),
                metadata,
                timestamp: Date.now(),
              };
            }
          } catch (err) {
            log.warn({ cascadeId, err }, '[F172] antigravity image publish failed');
          }
        }

        // F172 Phase G: brain dir scanner — the primary path for built-in
        // generate_image, whose product lands at
        // ~/.gemini/antigravity/brain/<cascadeId>/<imageName>_<unixMs>.<ext>
        // and never surfaces an absolute path in toolResult.output.
        if (collectedGenerateImageSteps.length > 0 && cascadeId) {
          try {
            const published = await scanAndPublishAntigravityBrainImages({
              steps: collectedGenerateImageSteps,
              cascadeId,
              uploadDir: options?.uploadDir,
            });
            for (const img of published) {
              yield {
                type: 'system_info' as const,
                catId: this.catId,
                content: JSON.stringify({ type: 'rich_block', block: img.richBlock, provenance: img.provenance }),
                metadata,
                timestamp: Date.now(),
              };
            }
          } catch (err) {
            log.warn({ cascadeId, err }, '[F172] antigravity brain scan failed');
          }
        }

        if (!terminalAbort) {
          await persistSupervisor({
            status: 'done',
            recoveryStrategy: 'wait',
            lastObservedStepCount: lastDelivered,
            lastDeliveredStepIndex: lastDelivered,
            auditType: 'supervisor_done',
          });
        }
        await flushSideEffectJournalAudit();
        yield { type: 'done', catId: this.catId, metadata, timestamp: Date.now() };
        return;
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.error(`invoke failed: ${errorMsg}`);
      await flushSideEffectJournalAudit();
      yield { type: 'error', catId: this.catId, error: errorMsg, metadata, timestamp: Date.now() };
      yield { type: 'done', catId: this.catId, metadata, timestamp: Date.now() };
    }
  }
}
