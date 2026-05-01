/**
 * Antigravity Agent Service — Bridge-owned writeback architecture.
 *
 * Replaces CDP WebSocket hack with ConnectRPC via AntigravityBridge.
 * Antigravity thinks (via LS cascade), Bridge reads back and yields AgentMessages.
 */
import { join } from 'node:path';
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
import { classifyStep, transformTrajectorySteps } from './antigravity-event-transformer.js';
import {
  collectImagePathsFromSteps,
  publishAntigravityImages,
  scanAndPublishAntigravityBrainImages,
} from './antigravity-image-publisher.js';
import { summarizeStepShape, TRACE_ENABLED, traceLog } from './antigravity-trace.js';
import { AuditLogger } from './executors/AuditLogger.js';
import { ExecutorRegistry } from './executors/ExecutorRegistry.js';
import { isReadOnlyRunCommand, RunCommandExecutor } from './executors/RunCommandExecutor.js';

const log = createModuleLogger('antigravity-service');
const STREAM_ERROR_GRACE_WINDOW_MS = 4_500;
const DEFAULT_MODEL_CAPACITY_RETRY_DELAYS_MS = [1_000, 3_000, 5_000, 10_000, 15_000, 20_000, 30_000, 36_000];

function sanitizeRetryDelays(delays?: readonly number[]): number[] {
  return (delays ?? DEFAULT_MODEL_CAPACITY_RETRY_DELAYS_MS).filter(
    (delay): delay is number => Number.isFinite(delay) && delay >= 0,
  );
}

function buildCapacityRetrySignal(
  catId: CatId,
  metadata: MessageMetadata,
  attempt: number,
  totalAttempts: number,
  delayMs: number,
): AgentMessage {
  const seconds = delayMs >= 1000 ? `${Math.round(delayMs / 1000)}s` : `${delayMs}ms`;
  return {
    type: 'provider_signal',
    catId,
    content: JSON.stringify({
      type: 'warning',
      message: `上游模型服务端容量不足，系统将在 ${seconds} 后自动重试（${attempt}/${totalAttempts}）`,
    }),
    metadata,
    timestamp: Date.now(),
  };
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

  return `\n[Cat Cafe callback fallback]\n如果当前环境已挂载只读 Cat Cafe MCP（常见为 search_evidence / reflect / session-chain / signals），这些读工具可直接使用。共享 Antigravity MCP 的 agent-key 工具（post_message / get_thread_context / list_threads / cross_post_message）必须带 agentKeyCatId="${catId}"，这样 Gemini/Claude variant 会使用各自身份的 sidecar key。当前 invocation / thread 的写回凭证也可通过 run_command 调 HTTP callback。\n- 当前 thread 上下文: curl -fsS "${apiUrl}/api/callbacks/thread-context?invocationId=${invocationId}&callbackToken=${callbackToken}&limit=20"\n- 带关键词过滤: curl -fsS "${apiUrl}/api/callbacks/thread-context?invocationId=${invocationId}&callbackToken=${callbackToken}&keyword=review"\n- 发消息回当前 thread: curl -fsS -X POST "${apiUrl}/api/callbacks/post-message" -H 'Content-Type: application/json' -d '{"invocationId":"${invocationId}","callbackToken":"${callbackToken}","content":"<message>"}'\n- 完整文档（public / static，无需凭证）: curl -fsS "${apiUrl}/api/callbacks/instructions"\n\n[Cold-start onboarding — 新 cascade 必读]\nAntigravity 持久 cascade 累积过多 step 时（>200）会因 context 撑爆产生 empty PLANNER_RESPONSE，这时铲屎官可能让你 New Cascade 重启。**新 cascade 是 fresh state，你之前的工作记忆会丢**。第一次回应铲屎官前，**先把上下文找回来**——只需要用 readonly MCP 白名单里的工具，不依赖任何 callback 凭证。当前 thread / cat 已经在 prompt 里给你了：threadId="${threadId ?? ''}", catId="${catId}"，照搬即可。\n1. **读上几次 session 的工作记忆**：cat_cafe_list_session_chain({ threadId: "${threadId ?? ''}", catId: "${catId}", limit: 5 }) 拿到最近 session 列表 → 对最近的 1-2 个 sessionId 调 cat_cafe_read_session_digest({ sessionId }) 看你之前在做什么、卡在哪、已交付什么。这是最浓缩的"自己脑子里的活"摘要。\n2. **找当前 feature 文档**：从 session digest 里能抠出 feature ID（F0xx）或关键词，cat_cafe_search_evidence({ query: "<feature ID 或关键词>", scope: "docs", mode: "hybrid" }) 拿真相源（spec / 决策 / lessons）。\n3. **如需更细的工作过程证据**：cat_cafe_read_session_events({ sessionId, limit: 50 }) 看单个 session 内具体调了哪些工具、产生了哪些消息。\n4. 把"我是 Bengal Cat 孟加拉猫，刚被 New Cascade 重启，读了 session chain 最近 X 个 digest，理解了上下文是 ___，正在做的是 ___，准备继续 ___"作为开场白回给铲屎官，让他看到你已经找回记忆。\n这一套约 2-4 次 tool 调用，比让铲屎官手把手 onboard 快得多。所有用到的工具（list_session_chain / read_session_digest / read_session_events / search_evidence）都在 readonly MCP 白名单，无需 callback 凭证、无 UI 审批。\n\n[F061 Bug-F workaround — shell exec via MCP]\n当 Antigravity UI permission gate 拦截 pwd / git 等只读命令时（user denied permission），优先用 MCP 工具 cat_cafe_shell_exec 代替 cascade run_command。cat_cafe_shell_exec 走 MCP stdio，不经 cascade UI gate。**只读命令白名单（严格）**：pwd / ls / cat / git log|status|rev-parse|diff|show。**路径参数必须在 ALLOWED_WORKSPACE_DIRS 范围内**（和 file-tools 同边界）。**默认 cwd 自动指向 workspace 根目录**（ALLOWED_WORKSPACE_DIRS 第一项），所以**不传 cwd 参数也能直接跑**——例如 cat_cafe_shell_exec({ commandLine: "git log --oneline -3" }) 立即返回结果，无需手动指定 cwd。**不在 whitelist 的工具**（curl / rm / mkdir / git branch|checkout|commit / npm install 等）**仍需走 cascade run_command + 用户 UI 审批**。注意：上面说的 "curl 调 HTTP callback" 路径是独立的——thread-context / post-message / instructions 这些 HTTP callback 仍必须用 curl via cascade run_command（需要用户批准一次），不走 cat_cafe_shell_exec。`;
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
  /** Grace window for buffered recoverable stream_error before surfacing it (default: 4500ms) */
  streamErrorGraceWindowMs?: number;
  /** Capacity retry backoff schedule in ms (default: ~120s total budget). Empty = disabled. */
  modelCapacityRetryDelaysMs?: readonly number[];
}

export class AntigravityAgentService implements AgentService {
  readonly catId: CatId;
  private readonly model: string;
  private readonly bridge: AntigravityBridge;
  private readonly pollTimeoutMs: number;
  private readonly autoApprove: boolean;
  private readonly streamErrorGraceWindowMs: number;
  private readonly modelCapacityRetryDelaysMs: number[];

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
    this.autoApprove = options?.autoApprove ?? process.env['ANTIGRAVITY_AUTO_APPROVE'] !== 'false';
    this.streamErrorGraceWindowMs = options?.streamErrorGraceWindowMs ?? STREAM_ERROR_GRACE_WINDOW_MS;
    this.modelCapacityRetryDelaysMs = sanitizeRetryDelays(options?.modelCapacityRetryDelaysMs);

    // F061 Phase 2c: auto-attach default native executors when the service owns its bridge.
    // Tests that inject a mock bridge opt out here; they stub nativeExecuteAndPush directly.
    if (!injectedBridge) {
      const registry = new ExecutorRegistry();
      registry.register(
        new RunCommandExecutor({
          rpc: (method, payload) => this.bridge.callRpc(method, payload),
        }),
      );
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
      let capacityRetryCount = 0;

      const makeSessionInit = (sessionId: string): AgentMessage => ({
        type: 'session_init',
        catId: this.catId,
        sessionId,
        ephemeralSession: true,
        metadata,
        timestamp: Date.now(),
      });

      log.info(`invoke: cascade=${cascadeId}, thread=${threadId}, model=${this.model}`);
      yield makeSessionInit(cascadeId);

      while (true) {
        const stepsBefore = await this.bridge.sendMessage(cascadeId, effectivePrompt, this.model);

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
        let stallProbed = false;
        let lastDelivered = stepsBefore;
        let attemptHasToolActivity = false;
        let attemptHasDispatchedToolResult = false;
        let attemptHasNativeDispatch = false;
        let attemptHasResolvedToolishStep = false;
        let modelCapacityRetryDelayMs: number | null = null;
        const handledToolCallIds = new Set<string>();
        let pendingStreamError: AgentMessage | null = null;
        let streamErrorGraceDeadline = 0;
        let pendingStreamErrorMetricAttrs: Record<string, string> = {
          [GENAI_SYSTEM]: 'antigravity',
          [GENAI_MODEL]: normalizeModel(this.model),
          [STREAM_ERROR_PATH]: 'partial_text',
        };

        const clearPendingStreamError = (reason: 'recovered' | 'superseded' | 'expired') => {
          if (!pendingStreamError) return;
          if (reason === 'recovered') {
            antigravityStreamErrorRecovered.add(1, pendingStreamErrorMetricAttrs);
          } else if (reason === 'expired') {
            antigravityStreamErrorExpired.add(1, pendingStreamErrorMetricAttrs);
          }
          pendingStreamError = null;
          streamErrorGraceDeadline = 0;
        };

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
                log.warn({ cascadeId }, 'stream_error grace expired without recovery');
                yield pendingStreamError;
                clearPendingStreamError('expired');
                terminalAbort = true;
                try {
                  await iterator.return?.(undefined);
                } catch {
                  // best-effort cleanup only
                }
                return;
              }

              let timeoutHandle;
              const raced = await Promise.race([
                iterator.next(),
                new Promise<'__grace_timeout__'>((resolve) => {
                  timeoutHandle = setTimeout(() => resolve('__grace_timeout__'), remainingMs);
                }),
              ]);
              clearTimeout(timeoutHandle);
              if (raced === '__grace_timeout__') {
                log.warn({ cascadeId }, 'stream_error grace expired without recovery');
                yield pendingStreamError;
                clearPendingStreamError('expired');
                terminalAbort = true;
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
            if (batch.cursor.awaitingUserInput) {
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
                stallProbed = false;
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
              const batchHasText = messages.some((msg) => msg.type === 'text' && Boolean(msg.content));
              const batchHasToolActivity = messages.some(
                (msg) => msg.type === 'tool_use' || msg.type === 'tool_result',
              );
              const batchHasToolishStep = batch.steps.some(
                (step) =>
                  step.type === 'CORTEX_STEP_TYPE_RUN_COMMAND' ||
                  step.status === 'CORTEX_STEP_STATUS_WAITING' ||
                  Boolean(step.toolCall) ||
                  Boolean(step.toolResult) ||
                  Boolean(step.metadata?.toolCall?.id),
              );
              const batchHasUpstreamError = messages.some(
                (msg) => msg.type === 'error' && msg.errorCode === 'upstream_error',
              );
              const batchHasModelCapacity = messages.some(
                (msg) => msg.type === 'error' && msg.errorCode === 'model_capacity',
              );
              const getToolishToolName = (step: (typeof batch.steps)[number] | undefined) =>
                step?.metadata?.toolCall?.name ?? step?.toolCall?.toolName ?? step?.toolResult?.toolName;
              const firstToolishStep = batch.steps.find(
                (step) =>
                  step.type === 'CORTEX_STEP_TYPE_RUN_COMMAND' ||
                  step.status === 'CORTEX_STEP_STATUS_WAITING' ||
                  Boolean(step.toolCall) ||
                  Boolean(step.toolResult) ||
                  Boolean(step.metadata?.toolCall?.id),
              );
              const allBatchToolishStepCount = batch.steps.filter(
                (step) =>
                  step.type === 'CORTEX_STEP_TYPE_RUN_COMMAND' ||
                  step.status === 'CORTEX_STEP_STATUS_WAITING' ||
                  Boolean(step.toolCall) ||
                  Boolean(step.toolResult) ||
                  Boolean(step.metadata?.toolCall?.id),
              ).length;
              const batchHasResolvedToolishStep = batch.steps.some((step) => {
                const isToolish =
                  step.type === 'CORTEX_STEP_TYPE_RUN_COMMAND' ||
                  Boolean(step.toolCall) ||
                  Boolean(step.toolResult) ||
                  Boolean(step.metadata?.toolCall?.id);
                if (!isToolish) return false;
                if (step.type === 'CORTEX_STEP_TYPE_RUN_COMMAND') {
                  return step.status !== 'CORTEX_STEP_STATUS_WAITING' && step.status !== 'CORTEX_STEP_STATUS_ERROR';
                }
                return step.status !== 'CORTEX_STEP_STATUS_WAITING';
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
                waitingToolishSteps.length === 1 &&
                blockingStepIsRunCommand &&
                blockingToolishStep?.status === 'CORTEX_STEP_STATUS_WAITING' &&
                true;
              const toolishRetryEligible =
                singleBlockingWaitingRunCommand && toolishSafeToAutoRun && toolishCommandLine
                  ? isReadOnlyRunCommand(toolishCommandLine)
                  : false;
              const buildBeforeDispatchDiagnostics = (failureLayer: string, extra: Record<string, unknown> = {}) => ({
                failureLayer,
                dispatchState:
                  batchHasResolvedToolishStep ||
                  attemptHasResolvedToolishStep ||
                  attemptHasNativeDispatch ||
                  attemptHasDispatchedToolResult
                    ? 'after_dispatch'
                    : batchHasToolishStep
                      ? 'before_dispatch'
                      : 'unknown',
                toolishStepType: blockingToolishStep?.type,
                toolishToolName,
                executionJournal: {
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
                },
                toolishRetryEligible,
                ...extra,
              });
              const shouldRetryModelCapacity =
                batchHasModelCapacity &&
                !batchHasUpstreamError &&
                !hasText &&
                !batchHasText &&
                !attemptHasResolvedToolishStep &&
                !attemptHasNativeDispatch &&
                !attemptHasToolActivity &&
                !batchHasToolActivity &&
                (!batchHasToolishStep || toolishRetryEligible) &&
                capacityRetryCount < self.modelCapacityRetryDelaysMs.length;

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
                  shouldRetryModelCapacity,
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

              const seenFatalKeys = new Set<string>();
              const batchHasSpecificError = messages.some(
                (msg) =>
                  msg.type === 'error' && (msg.errorCode === 'upstream_error' || msg.errorCode === 'model_capacity'),
              );
              for (const msg of messages) {
                const isFatal = msg.type === 'error' && msg.errorCode && msg.errorCode !== 'tool_error';
                if (!isFatal) {
                  if (shouldRetryModelCapacity && msg.type === 'provider_signal') {
                    continue;
                  }
                  if (msg.type === 'text') {
                    if (pendingStreamError) {
                      log.info({ cascadeId }, 'stream_error recovered mid-stream');
                      clearPendingStreamError('recovered');
                    }
                    hasText = true;
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

                if (msg.errorCode === 'model_capacity') {
                  if (pendingStreamError) {
                    log.info({ cascadeId }, 'stream_error superseded by model_capacity');
                    clearPendingStreamError('superseded');
                  }
                  if (shouldRetryModelCapacity) {
                    modelCapacityRetryDelayMs = self.modelCapacityRetryDelaysMs[capacityRetryCount] ?? null;
                    continue;
                  }
                  fatalSeen = true;
                  terminalAbort = true;
                  const errorMetadata = msg.metadata ?? metadata;
                  // This branch is exactly the ambiguity we are debugging:
                  // the model has surfaced a capacity error, but we also saw a
                  // tool-ish step in the same batch, so automatic retry is
                  // intentionally suppressed until we know whether dispatch ran.
                  yield {
                    ...msg,
                    metadata: {
                      ...errorMetadata,
                      diagnostics: {
                        ...errorMetadata.diagnostics,
                        ...buildBeforeDispatchDiagnostics('provider_capacity', {
                          retryEligible: false,
                          retrySuppressedBy:
                            batchHasResolvedToolishStep || attemptHasResolvedToolishStep
                              ? 'resolved_toolish_step_seen'
                              : attemptHasNativeDispatch
                                ? 'native_dispatch_seen'
                                : attemptHasToolActivity || batchHasToolActivity
                                  ? 'tool_activity_seen'
                                  : batchHasToolishStep && !toolishRetryEligible
                                    ? 'toolish_step_present'
                                    : hasText || batchHasText
                                      ? 'text_seen'
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
                  continue;
                }

                fatalSeen = true;
                if (msg.errorCode === 'upstream_error') {
                  if (pendingStreamError) {
                    log.info({ cascadeId }, 'stream_error superseded by upstream_error');
                    clearPendingStreamError('superseded');
                  }
                  const errorMetadata = msg.metadata ?? metadata;
                  const rawError = msg.error ?? '';
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
                log.info({ cascadeId, delayMs: modelCapacityRetryDelayMs }, 'model_capacity retry requested');
                return;
              }

              if (terminalAbort) break;
              for (const step of batch.steps) {
                const toolCallId = step.metadata?.toolCall?.id;
                if (toolCallId && handledToolCallIds.has(toolCallId)) continue;
                try {
                  const handled = await self.bridge.nativeExecuteAndPush(step, {
                    cascadeId,
                    cwd: sanitizedDir,
                    modelName: self.model,
                  });
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
                  log.warn(`nativeExecuteAndPush failed for step: ${err}`);
                }
              }
              if (batchHasResolvedToolishStep) {
                attemptHasResolvedToolishStep = true;
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
              log.warn({ cascadeId }, 'stream_error grace expired after poll completion without recovery');
              yield pendingStreamError;
              clearPendingStreamError('expired');
              terminalAbort = true;
            }
          } catch (err) {
            const isStall = err instanceof Error && err.message.includes('stall');
            if (pendingStreamError && isStall) {
              log.warn({ cascadeId }, 'stream_error grace expired on stall without recovery');
              yield pendingStreamError;
              clearPendingStreamError('expired');
              terminalAbort = true;
              break;
            }
            if (isStall && this.autoApprove && !stallProbed) {
              stallProbed = true;
              try {
                await this.bridge.resolveOutstandingSteps(cascadeId);
                log.info(`probe-approved on stall for cascade ${cascadeId}, retrying poll from step ${lastDelivered}`);
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
          capacityRetryCount += 1;
          yield buildCapacityRetrySignal(
            this.catId,
            metadata,
            capacityRetryCount,
            this.modelCapacityRetryDelaysMs.length,
            modelCapacityRetryDelayMs,
          );
          log.info(
            { cascadeId, threadId, retryCount: capacityRetryCount, delayMs: modelCapacityRetryDelayMs },
            'retrying Antigravity invoke after model_capacity',
          );
          await sleepWithAbort(modelCapacityRetryDelayMs, options?.signal);
          this.bridge.resetSession(threadId, this.catId as string);
          cascadeId = await this.bridge.getOrCreateSession(threadId, this.catId as string);
          yield makeSessionInit(cascadeId);
          continue;
        }

        // F172 Phase H: image-only response is a valid user-visible output —
        // Phase G yields a media_gallery rich block via the brain scanner and
        // Phase F yields one via the toolResult-path publisher (future-proof).
        // empty_response only fires when neither text NOR an image surfaced.
        const sawImageOutput = collectedGenerateImageSteps.length > 0 || collectedImagePaths.size > 0;
        if (!hasText && !fatalSeen && !sawImageOutput) {
          const diagnostics = {
            totalStepsSeen,
            rawStepTypeCounts,
            transformedMessageTypeCounts,
            lastBatchStepTypes,
            lastDelivered,
            hasText,
            fatalSeen,
            cascadeId,
          };
          log.warn(diagnostics, 'empty_response triggered — no text received from Antigravity');
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

        yield { type: 'done', catId: this.catId, metadata, timestamp: Date.now() };
        return;
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.error(`invoke failed: ${errorMsg}`);
      yield { type: 'error', catId: this.catId, error: errorMsg, metadata, timestamp: Date.now() };
      yield { type: 'done', catId: this.catId, metadata, timestamp: Date.now() };
    }
  }
}
