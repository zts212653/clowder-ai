/**
 * Single Cat Invocation
 * 单猫调用的核心逻辑，从 AgentRouter 提取。
 *
 * 处理: credentials 创建、session 获取、workingDirectory 解析、
 *       CLI 调用、消息 yield、错误处理、审计日志。
 *
 * 不处理: system prompt 构建（由调用方负责 prepend）、
 *         消息存储（由调用方在 yield 后累积并存储）。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  type CatId,
  type ContextHealth,
  catRegistry,
  type MessageContent,
  type SealReason,
  type SessionRecord,
} from '@cat-cafe/shared';
import { context, SpanStatusCode, trace } from '@opentelemetry/api';
import {
  resolveBuiltinClientForProvider,
  resolveForClient,
  validateRuntimeProviderBinding,
} from '../../../../../config/account-resolver.js';
import { resolveBoundAccountRefForCat } from '../../../../../config/cat-account-binding.js';
import { isSessionChainEnabled } from '../../../../../config/cat-config-loader.js';
import { buildCatGitIdentityEnv } from '../../../../../config/cat-git-identity.js';
import { getCatModel } from '../../../../../config/cat-models.js';
import {
  getContextWindowFallback,
  OPENCODE_DEFAULT_CONTEXT_WINDOW,
} from '../../../../../config/context-window-sizes.js';
import { getSessionStrategy, shouldTakeAction } from '../../../../../config/session-strategy.js';
import { assertSafeTestConfigRoot } from '../../../../../config/test-config-write-guard.js';
import { capturePromptIfEnabled } from '../../../../../infrastructure/debug/prompt-capture-bridge.js';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import {
  AGENT_ID,
  GENAI_MODEL,
  GENAI_SYSTEM,
  OPERATION_NAME,
  STATUS,
  TRIGGER,
} from '../../../../../infrastructure/telemetry/genai-semconv.js';
import {
  activeInvocations,
  catInvocationCount,
  catResponseDuration,
  geminiContextFallback,
  invocationCompleted,
  invocationDuration,
  llmCallDuration,
  sessionRounds,
  threadDuration,
  tokenUsage,
} from '../../../../../infrastructure/telemetry/instruments.js';
import { normalizeModel } from '../../../../../infrastructure/telemetry/model-normalizer.js';
import { emitOtelLog } from '../../../../../infrastructure/telemetry/otel-logger.js';
import {
  recordAgentLoop,
  recordLlmCallSpan,
  recordToolUseSpan,
} from '../../../../../infrastructure/telemetry/span-helpers.js';
import { ToolSpanTracker } from '../../../../../infrastructure/telemetry/tool-span-tracker.js';
import { resolveActiveProjectRoot } from '../../../../../utils/active-project-root.js';
import { resolveCliCommand } from '../../../../../utils/cli-resolve.js';
import { DEFAULT_CLI_TIMEOUT_MS, resolveCliTimeoutMs } from '../../../../../utils/cli-timeout.js';
import { findMonorepoRoot, isSameProject } from '../../../../../utils/monorepo-root.js';
import { isUnderAllowedRoot } from '../../../../../utils/project-path.js';
import { tcpProbe } from '../../../../../utils/tcp-probe.js';
import type { AgentPaneRegistry } from '../../../../terminal/agent-pane-registry.js';
import type { TmuxGateway } from '../../../../terminal/tmux-gateway.js';
import { resolveBootcampWorkspaceRoot } from '../../bootcamp/workspace-root.js';
import { createPromptDigest } from '../../context/prompt-digest.js';
// L0-budget-defense PR-B-impl (ADR-038): staging layer prepend, wired here
// (next to F225 contextHintPrefix) so it lands every turn including resumes.
import { buildStagingPrepend } from '../../context/StagingContent.js';
import { AuditEventTypes, getEventAuditLog } from '../../orchestration/EventAuditLog.js';
import { resolveDefaultClaudeMcpServerPath } from '../providers/ClaudeAgentService.js';
import { compileL0ViaSubprocess } from '../providers/l0-compiler.js';
import { OC_INSTRUCTIONS_ONLY_ENV } from '../providers/OpenCodeAgentService.js';
import {
  deriveOpenCodeApiType,
  OC_API_KEY_ENV,
  OC_BASE_URL_ENV,
  parseOpenCodeModel,
  safeProviderName,
  summarizeOpenCodeRuntimeConfigForDebug,
  writeOpenCodeInstructionsOnlyConfig,
  writeOpenCodeRuntimeConfig,
} from '../providers/opencode-config-template.js';
import { appendTranscriptPathHints } from '../providers/transcript-path-hints.js';
import { buildContextManagementHint, queueContextHint, takeContextHintPrefix } from './context-management-hint.js';

const log = createModuleLogger('invoke');
const tracer = trace.getTracer('cat-cafe-api', '0.1.0');
const TRANSCRIPT_DIR =
  process.env.TRANSCRIPT_DIR ?? resolve(findMonorepoRoot(), 'scripts', 'meeting-copilot', 'transcripts');
const CAT_INVOCATION_STALL_AUTO_KILL_MS = 7 * 60_000;
const ANTIGRAVITY_AUTOMATIC_RETRY_FRAGMENT_REASONS = new Set([
  'model_capacity',
  'empty_response',
  'stream_error',
  'tool_conflict',
  'runtime_disconnected',
]);
let _openCodeKnownModels: Set<string> | null = null;

export function getOpenCodeKnownModels(): Set<string> {
  if (_openCodeKnownModels !== null) return _openCodeKnownModels;
  try {
    const opencodePath = resolveCliCommand('opencode');
    if (!opencodePath) {
      _openCodeKnownModels = new Set();
      return _openCodeKnownModels;
    }
    const stdout = execFileSync(opencodePath, ['models'], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    _openCodeKnownModels = new Set(
      stdout
        .trim()
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
    );
  } catch {
    _openCodeKnownModels = new Set();
  }
  return _openCodeKnownModels;
}

/** @internal Exposed for tests */
export function _resetOpenCodeKnownModels(override?: Set<string> | null): void {
  _openCodeKnownModels = override ?? null;
}

import type {
  RuntimeSessionMetadata,
  RuntimeSessionUnexpectedRuntimeSessionSwitch,
} from '../../runtime-session/RuntimeSessionMetadata.js';
import type { IRuntimeSessionStore } from '../../runtime-session/RuntimeSessionStore.js';
import type { SessionManager } from '../../session/SessionManager.js';
import type { ISessionSealer } from '../../session/SessionSealer.js';
import type { TranscriptSessionInfo, TranscriptWriter } from '../../session/TranscriptWriter.js';
import type { ISessionChainStore } from '../../stores/ports/SessionChainStore.js';
import type { IThreadStore } from '../../stores/ports/ThreadStore.js';
import type { AgentMessage, AgentService, AgentServiceOptions } from '../../types.js';
import { hasL0CompilerSeam } from '../../types.js';
import type { InvocationRegistry } from '../invocation/InvocationRegistry.js';
import { completeCapsuleForSeal, type RouteStateContinuityCapsule } from './CollaborationContinuityCapsule.js';
import type { ResumeFailureKind } from './invoke-helpers.js';
import {
  classifyResumeFailure,
  extractTaskProgress,
  isCliTimeoutError,
  isContextWindowOverflowError,
  isMalformedToolCallError,
  isMissingClaudeSessionError,
  isPromptTokenLimitExceededError,
  isTransientAcpPromptFailure,
  isTransientCliExitCode1,
  preflightRace,
} from './invoke-helpers.js';
import { SessionMutex } from './SessionMutex.js';
import type { TaskProgressItem, TaskProgressStatus, TaskProgressStore } from './TaskProgressStore.js';

/** F118: Module-level singleton — guards per-cliSessionId serialization */
const sessionMutex = new SessionMutex();

/**
 * F089: Race an async iterator's .next() against an AbortSignal.
 * Returns the iterator result, or throws the abort reason if the signal fires first.
 * This is necessary because `for await` blocks on gen.next() and cannot be interrupted.
 */
function abortableNext<T>(iter: AsyncIterator<T>, signal: AbortSignal): Promise<IteratorResult<T>> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('aborted'));
  return new Promise<IteratorResult<T>>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason ?? new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    iter.next().then(
      (result) => {
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

const ANTHROPIC_PROFILE_MODE_KEY = 'CAT_CAFE_ANTHROPIC_PROFILE_MODE';
const ANTHROPIC_PROFILE_MODE_API_KEY = 'api_key';

/** Derive a URL-safe slug from profile ID for proxy routing. */
function deriveProxySlug(profileId: string): string {
  // "profile-a247a834-1ac1-4752-aa73-6bd159b9acc5" → "a247a834"
  const match = profileId.match(/^profile-([a-f0-9]+)/);
  return match?.[1] ?? profileId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** Register/update upstream mapping in .cat-cafe/proxy-upstreams.json (hot-reloaded by proxy). */
function registerProxyUpstream(projectRoot: string, slug: string, targetUrl: string): void {
  assertSafeTestConfigRoot(projectRoot, 'invoke-single-cat.registerProxyUpstream');
  const dir = resolve(projectRoot, '.cat-cafe');
  const filePath = resolve(dir, 'proxy-upstreams.json');
  let upstreams: Record<string, string> = {};
  try {
    if (existsSync(filePath)) {
      upstreams = JSON.parse(readFileSync(filePath, 'utf-8'));
    }
  } catch {
    /* start fresh */
  }
  if (upstreams[slug] === targetUrl) return; // no change
  upstreams[slug] = targetUrl;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(upstreams, null, 2)}\n`);
}

/**
 * F-BLOAT: Context compression detection for non-Claude providers (Codex/Gemini).
 *
 * Track last known context fill per cat:thread. When usedTokens drops >60%
 * between turns, mark for systemPrompt re-injection on the next invocation.
 * This handles the edge case where auto-compact fires before our seal threshold.
 *
 * Note: module-level state — lost on server restart (acceptable, seal handles 95% of cases).
 */
const _prevContextFill = new Map<string, number>();
const _needsReinjection = new Set<string>();
const _staticIdentityRegistryRevision = new Map<string, number>();

/** @internal Exposed for testing */
export function _resetCompressionDetection(): void {
  _prevContextFill.clear();
  _needsReinjection.clear();
}

/** @internal Exposed for testing */
export function _resetStaticIdentityRegistryRevisionForTests(): void {
  _staticIdentityRegistryRevision.clear();
}

function sessionIdentityKey(userId: string, catId: CatId, threadId: string): string {
  return `${userId}:${catId as string}:${threadId}`;
}

function isAntigravityRuntimeSessionInit(msg: AgentMessage): boolean {
  return (
    msg.type === 'session_init' &&
    msg.sessionLifecycle?.runtime === 'antigravity-desktop' &&
    typeof msg.sessionLifecycle.runtimeSessionId === 'string' &&
    msg.sessionLifecycle.runtimeSessionId.trim().length > 0
  );
}

const UNEXPECTED_RUNTIME_SESSION_SWITCH_SEAL_REASON = 'unexpected_runtime_session_switch';

function classifyUnexpectedRuntimeSessionSwitch(
  lifecycle: NonNullable<AgentMessage['sessionLifecycle']>,
  previousRuntimeSessionId: string,
): Pick<RuntimeSessionUnexpectedRuntimeSessionSwitch, 'declaredPreviousRuntimeSessionId' | 'reason'> | null {
  const declaredPreviousRuntimeSessionId = lifecycle.previousRuntimeSessionId?.trim();
  if (!declaredPreviousRuntimeSessionId) {
    return { reason: 'missing_previous_runtime_session_id' };
  }
  if (declaredPreviousRuntimeSessionId !== previousRuntimeSessionId) {
    return {
      declaredPreviousRuntimeSessionId,
      reason: 'mismatched_previous_runtime_session_id',
    };
  }
  return null;
}

function antigravityReplacementSealReason(msg: AgentMessage, previousRuntimeSessionId: string): string {
  if (isAntigravityRuntimeSessionInit(msg) && msg.sessionLifecycle) {
    const unexpected = classifyUnexpectedRuntimeSessionSwitch(msg.sessionLifecycle, previousRuntimeSessionId);
    if (unexpected) return UNEXPECTED_RUNTIME_SESSION_SWITCH_SEAL_REASON;
  }
  return msg.sessionLifecycle?.sealReason ?? 'cli_session_replaced';
}

function buildUnexpectedRuntimeSessionSwitch(input: {
  lifecycle: NonNullable<AgentMessage['sessionLifecycle']>;
  previousSessionId: string;
  previousRuntimeSessionId: string;
  currentRuntimeSessionId: string;
  detectedAt: number;
}): RuntimeSessionUnexpectedRuntimeSessionSwitch | null {
  const unexpected = classifyUnexpectedRuntimeSessionSwitch(input.lifecycle, input.previousRuntimeSessionId);
  if (!unexpected) return null;
  return {
    detectedAt: input.detectedAt,
    previousSessionId: input.previousSessionId,
    previousRuntimeSessionId: input.previousRuntimeSessionId,
    currentRuntimeSessionId: input.currentRuntimeSessionId,
    ...('declaredPreviousRuntimeSessionId' in unexpected && unexpected.declaredPreviousRuntimeSessionId
      ? { declaredPreviousRuntimeSessionId: unexpected.declaredPreviousRuntimeSessionId }
      : {}),
    reason: unexpected.reason,
  };
}

async function markPreviousAntigravityRetryFragment(input: {
  runtimeSessionStore: IRuntimeSessionStore;
  sessionChainStore: ISessionChainStore;
  lifecycle: NonNullable<AgentMessage['sessionLifecycle']>;
  activePreviousRuntimeSessionId?: string;
  userVisibleOutputSessionIds?: ReadonlySet<string>;
  threadId: string;
  catId: CatId;
  now: number;
}): Promise<void> {
  const previousRuntimeSessionId = input.lifecycle.previousRuntimeSessionId;
  const retryReason = input.lifecycle.sealReason;
  if (!previousRuntimeSessionId) return;
  if (!retryReason) return;
  if (!ANTIGRAVITY_AUTOMATIC_RETRY_FRAGMENT_REASONS.has(retryReason)) return;
  if (input.activePreviousRuntimeSessionId && previousRuntimeSessionId !== input.activePreviousRuntimeSessionId) return;

  const previousRuntime = await input.runtimeSessionStore.getByRuntimeSession(
    'antigravity-desktop',
    previousRuntimeSessionId,
  );
  if (!previousRuntime) return;
  if (!isRuntimeSessionInThread(previousRuntime, input.threadId, input.catId)) return;
  if (!input.activePreviousRuntimeSessionId && !isAlreadySealedAntigravityRetryPrevious(previousRuntime, retryReason)) {
    return;
  }
  if (input.userVisibleOutputSessionIds?.has(previousRuntime.sessionId)) return;

  const previousRecord = await input.sessionChainStore.get(previousRuntime.sessionId);
  if (!previousRecord) return;
  if (!isSessionRecordInThread(previousRecord, input.threadId, input.catId)) return;
  const activeRecord = await input.sessionChainStore.getActive(input.catId, input.threadId);
  if (activeRecord?.id === previousRecord.id) return;
  if (previousRecord.messageCount !== 0) return;

  await input.runtimeSessionStore.updateLifecycle(previousRuntime.sessionId, {
    retryFragment: {
      kind: 'retry',
      retryReason,
      nextRuntimeSessionId: input.lifecycle.runtimeSessionId,
      detectedAt: input.now,
    },
    lastObservedAt: Math.max(previousRuntime.lifecycle.lastObservedAt, input.now),
  });
}

function isAlreadySealedAntigravityRetryPrevious(runtimeSession: RuntimeSessionMetadata, retryReason: string): boolean {
  return runtimeSession.lifecycle.state !== 'active' && runtimeSession.lifecycle.sealReason === retryReason;
}

function isRuntimeSessionInThread(runtimeSession: RuntimeSessionMetadata, threadId: string, catId: CatId): boolean {
  return runtimeSession.threadId === threadId && runtimeSession.catId === catId;
}

function isSessionRecordInThread(session: SessionRecord, threadId: string, catId: CatId): boolean {
  return session.threadId === threadId && session.catId === catId;
}

function isUserVisibleSessionOutput(msg: AgentMessage): boolean {
  return msg.type === 'text' || msg.type === 'tool_use' || msg.type === 'tool_result';
}

async function syncAntigravityRuntimeMetadata(input: {
  runtimeSessionStore: IRuntimeSessionStore;
  sessionChainStore: ISessionChainStore;
  activeRec: SessionRecord;
  msg: AgentMessage;
  userVisibleOutputSessionIds?: ReadonlySet<string>;
  threadId: string;
  catId: CatId;
  userId: string;
}): Promise<void> {
  if (!isAntigravityRuntimeSessionInit(input.msg)) return;
  const lifecycle = input.msg.sessionLifecycle;
  if (!lifecycle) return;
  if (typeof input.msg.sessionId !== 'string' || input.activeRec.cliSessionId !== input.msg.sessionId) return;

  const runtimeSessionId = lifecycle.runtimeSessionId;
  const now = Date.now();
  const activeRuntime = await input.runtimeSessionStore.getActiveByThreadCat(
    'antigravity-desktop',
    input.threadId,
    input.catId,
  );
  const activeRuntimeBeingReplaced =
    activeRuntime &&
    activeRuntime.runtimeSessionId !== runtimeSessionId &&
    activeRuntime.sessionId !== input.activeRec.id
      ? activeRuntime
      : null;
  const unexpectedRuntimeSessionSwitch = activeRuntimeBeingReplaced
    ? buildUnexpectedRuntimeSessionSwitch({
        lifecycle,
        previousSessionId: activeRuntimeBeingReplaced.sessionId,
        previousRuntimeSessionId: activeRuntimeBeingReplaced.runtimeSessionId,
        currentRuntimeSessionId: runtimeSessionId,
        detectedAt: now,
      })
    : null;
  if (activeRuntimeBeingReplaced) {
    const hostRecord = await input.sessionChainStore.get(activeRuntimeBeingReplaced.sessionId);
    if (hostRecord && hostRecord.threadId === input.threadId && hostRecord.catId === input.catId) {
      const sealReason =
        unexpectedRuntimeSessionSwitch !== null
          ? UNEXPECTED_RUNTIME_SESSION_SWITCH_SEAL_REASON
          : (lifecycle.sealReason ?? activeRuntimeBeingReplaced.lifecycle.sealReason ?? 'cli_session_replaced');
      const drainIncomplete =
        lifecycle.degraded === true || (lifecycle.drainResult && lifecycle.drainResult !== 'complete');
      await input.runtimeSessionStore.updateLifecycle(activeRuntimeBeingReplaced.sessionId, {
        state: drainIncomplete ? 'runtime_seal_pending' : 'sealed',
        sealReason,
        ...(lifecycle.drainResult ? { drainResult: lifecycle.drainResult } : {}),
        ...(drainIncomplete
          ? {
              pendingSince: activeRuntimeBeingReplaced.lifecycle.pendingSince ?? now,
              retryCount: activeRuntimeBeingReplaced.lifecycle.retryCount ?? 0,
              lastFailureReason:
                lifecycle.degradedReason ??
                activeRuntimeBeingReplaced.lifecycle.lastFailureReason ??
                'runtime drain did not prove completion',
            }
          : {}),
        lastObservedAt: now,
      });
    } else {
      await input.runtimeSessionStore.updateLifecycle(activeRuntimeBeingReplaced.sessionId, {
        state: 'runtime_conflict_pending',
        lastObservedAt: now,
        lastFailureReason: `active runtime binding ${activeRuntimeBeingReplaced.runtimeSessionId} points to missing SessionRecord ${activeRuntimeBeingReplaced.sessionId}`,
      });
    }
  }

  await markPreviousAntigravityRetryFragment({
    runtimeSessionStore: input.runtimeSessionStore,
    sessionChainStore: input.sessionChainStore,
    lifecycle,
    activePreviousRuntimeSessionId: activeRuntimeBeingReplaced?.runtimeSessionId,
    userVisibleOutputSessionIds: input.userVisibleOutputSessionIds,
    threadId: input.threadId,
    catId: input.catId,
    now,
  });

  const existingRuntime = await input.runtimeSessionStore.getByRuntimeSession('antigravity-desktop', runtimeSessionId);
  const identityHistory =
    existingRuntime?.sessionId === input.activeRec.id && existingRuntime.identityHistory.length > 0
      ? existingRuntime.identityHistory
      : [
          {
            catId: input.catId,
            model: input.msg.metadata?.model ?? 'unknown',
            ...(typeof input.msg.metadata?.modelVerified === 'boolean'
              ? { modelVerified: input.msg.metadata.modelVerified }
              : {}),
            ...(input.msg.metadata?.provider ? { provider: input.msg.metadata.provider } : {}),
            from: now,
            source: 'session_init' as const,
          },
        ];

  await input.runtimeSessionStore.upsert({
    sessionId: input.activeRec.id,
    runtime: 'antigravity-desktop',
    runtimeSessionId,
    threadId: input.threadId,
    catId: input.catId,
    userId: input.userId,
    surface: 'cat-cafe-dispatch',
    identityHistory,
    lifecycle: {
      state: 'active',
      startedAt: existingRuntime?.sessionId === input.activeRec.id ? existingRuntime.lifecycle.startedAt : now,
      lastObservedAt: now,
      ...((unexpectedRuntimeSessionSwitch ?? existingRuntime?.lifecycle.unexpectedRuntimeSessionSwitch)
        ? {
            unexpectedRuntimeSessionSwitch:
              unexpectedRuntimeSessionSwitch ?? existingRuntime?.lifecycle.unexpectedRuntimeSessionSwitch,
          }
        : {}),
    },
  });
}

/**
 * Shared dependencies for all cat invocations within one AgentRouter
 */
export interface InvocationDeps {
  readonly registry: InvocationRegistry;
  readonly sessionManager: SessionManager;
  readonly threadStore: IThreadStore | null;
  readonly apiUrl: string;
  /** F045 Gap #4: Redis-backed task progress snapshots (optional in memory mode/tests) */
  readonly taskProgressStore?: TaskProgressStore;
  /** F24: Session chain store for context health tracking */
  readonly sessionChainStore?: ISessionChainStore;
  /** F211 Phase A2: runtime sidecar for provider runtime session metadata. */
  readonly runtimeSessionStore?: IRuntimeSessionStore;
  /** F24 Phase B: Session sealer for auto-seal when context threshold reached */
  readonly sessionSealer?: ISessionSealer;
  /** F24 Phase C: Transcript writer for event collection + flush on seal */
  readonly transcriptWriter?: TranscriptWriter;
  /** F24 Phase D: Transcript reader for reading sealed session data */
  readonly transcriptReader?: import('../../session/TranscriptReader.js').TranscriptReader;
  /** F065: Task store for bootstrap task snapshot injection */
  readonly taskStore?: import('../../stores/ports/TaskStore.js').ITaskStore;
  /** F073 P4: Workflow SOP store for SOP stage hint injection */
  readonly workflowSopStore?: import('../../stores/ports/WorkflowSopStore.js').IWorkflowSopStore;
  /** F070 Phase 3a: Execution digest store for dispatch backflow */
  readonly executionDigestStore?: import('../../../../projects/execution-digest-store.js').ExecutionDigestStore;
  /** F089 Phase 2: tmux gateway for agent-in-pane execution */
  readonly tmuxGateway?: TmuxGateway;
  /** F089 Phase 2: agent pane registry for observability */
  readonly agentPaneRegistry?: AgentPaneRegistry;
  /** F155 B-4: Independent guide session store (optional, fallback to threadStore-backed bridge) */
  readonly guideSessionStore?: import('../../../../guides/GuideSessionRepository.js').IGuideSessionStore;
  /** F155 B-6: Dismiss tracker for guide offer suppression */
  readonly dismissTracker?: import('../../../../guides/GuideDismissTracker.js').IGuideDismissTracker;
  /** F091: Lookup signal articles linked to a thread for context injection */
  readonly signalArticleLookup?: (threadId: string) => Promise<
    readonly {
      id: string;
      title: string;
      source: string;
      tier: number;
      contentSnippet: string;
      note?: string | undefined;
      relatedDiscussions?: readonly { sessionId: string; snippet: string; score: number }[] | undefined;
    }[]
  >;
  /** F229: Concierge config store for duty-cat岗位 prompt injection (optional, fail-open) */
  readonly conciergeConfigStore?: import('../../../../concierge/ConciergeConfigStore.js').IConciergeConfigStore;
  /** F229 KD-17: HandleMap store for concierge R1/R2 short-handle → anchor mapping (optional, fail-open) */
  readonly conciergeHandleMapStore?: import('../../../../concierge/ConciergeHandleMapStore.js').IConciergeHandleMapStore;
  /** F229 Phase B: TriagePlan store for triage-plan marker → confirm/cancel card actions (optional, fail-open) */
  readonly conciergeTriagePlanStore?: import('../../../../concierge/ConciergeTriagePlanStore.js').IConciergeTriagePlanStore;
}

/**
 * Per-invocation parameters
 */
export interface InvocationParams {
  readonly catId: CatId;
  readonly service: AgentService;
  /** The fully-orchestrated prompt (dynamic context + chain context already prepended by caller) */
  readonly prompt: string;
  readonly userId: string;
  readonly threadId: string;
  readonly contentBlocks?: readonly MessageContent[];
  readonly uploadDir?: string;
  readonly signal?: AbortSignal;
  readonly isLastCat: boolean;
  /** Static identity prompt — prepended to prompt on new sessions (gated by F-BLOAT logic) */
  readonly systemPrompt?: string;
  /** F108 fix: InvocationRecordStore's parent invocation ID for worklist key alignment */
  readonly parentInvocationId?: string;
  /** F121: The A2A trigger message ID for auto-replyTo */
  readonly a2aTriggerMessageId?: string;
  /** F153 Phase E: Parent route span — invocation span becomes its child */
  readonly routeSpan?: import('@opentelemetry/api').Span;
  /** F153: mutable ref so caller can capture the invocation span for trace propagation */
  readonly invocationSpanRef?: { current?: import('@opentelemetry/api').Span };
  /** #502 PR2: structured route control state to persist on threshold seal. */
  readonly continuityCapsule?: RouteStateContinuityCapsule;
}

/**
 * Invoke a single cat agent and yield messages.
 *
 * The caller is responsible for:
 * - Building and prepending the system prompt to params.prompt
 * - Accumulating text/metadata from yielded messages
 * - Storing the final response in messageStore
 */
export async function* invokeSingleCat(deps: InvocationDeps, params: InvocationParams): AsyncIterable<AgentMessage> {
  const { registry, sessionManager, threadStore, apiUrl } = deps;
  const { catId, service, prompt, userId, threadId, isLastCat, signal: callerSignal } = params;

  // F198 Bug #3: a bg carrier has no stable per-conversation sessionId — the
  // daemon forks a fresh UUID every `--bg --resume` round. Derive a stable
  // chainKey anchor so sessionId resolution / resume mutex / session_init
  // record reuse / done bookkeeping all route through it instead of the
  // rotating cliSessionId. Non-bg services are untouched (usesChainKeyResume
  // defaults false → bgChainKey stays undefined and every existing path runs).
  const isBgCarrier = service.usesChainKeyResume?.() ?? false;
  const bgChainKey = isBgCarrier ? `bg:${threadId}:${catId}` : undefined;

  const { invocationId, callbackToken } = await registry.create(
    userId,
    catId,
    threadId,
    params.parentInvocationId,
    params.a2aTriggerMessageId,
  );

  // F153: Record cat invocation count with trigger type
  const triggerType = params.a2aTriggerMessageId ? 'mention' : params.parentInvocationId ? 'routing' : 'default';
  catInvocationCount.add(1, { [AGENT_ID]: catId, [TRIGGER]: triggerType });

  // F089: Invocation-level hard timeout — independent of NDJSON stream / CLI timeout.
  // Must be > CLI_TIMEOUT_MS to avoid racing the inner timeout.
  // When CLI_TIMEOUT_MS=0 (disable), fall back to DEFAULT (30min) so invocation still has a ceiling.
  const INVOCATION_TIMEOUT_MULTIPLIER = 2;
  const cliTimeoutMs = resolveCliTimeoutMs(undefined);
  const invocationTimeoutMs =
    (cliTimeoutMs > 0 ? cliTimeoutMs : DEFAULT_CLI_TIMEOUT_MS) * INVOCATION_TIMEOUT_MULTIPLIER;
  const invocationAc = new AbortController();
  let invocationTimer: ReturnType<typeof setTimeout> | null = null;
  const resetInvocationTimeout = (): void => {
    if (invocationTimer) clearTimeout(invocationTimer);
    invocationTimer = setTimeout(() => {
      log.error({ invocationId, catId, threadId, timeoutMs: invocationTimeoutMs }, 'Invocation hard timeout fired');
      invocationAc.abort(new Error('invocation_timeout'));
    }, invocationTimeoutMs);
    invocationTimer.unref();
  };
  resetInvocationTimeout();

  // Merge caller signal (user cancel) with invocation timeout — neither loses semantics.
  const signal: AbortSignal | undefined = callerSignal
    ? AbortSignal.any([callerSignal, invocationAc.signal])
    : invocationAc.signal;

  log.info({ invocationId, catId, threadId, userId }, 'Created invocation');

  // F22 R2 P1-1: Expose invocationId to caller (route-serial/parallel) so they can
  // use it for RichBlockBuffer.consume() instead of getLatestId() which is wrong
  // under preemption — old invocation A would steal new invocation B's blocks.
  yield {
    type: 'system_info' as const,
    catId,
    content: JSON.stringify({ type: 'invocation_created', invocationId }),
    timestamp: Date.now(),
  };

  const callbackEnv: Record<string, string> = {
    CAT_CAFE_API_URL: apiUrl,
    CAT_CAFE_INVOCATION_ID: invocationId,
    CAT_CAFE_CALLBACK_TOKEN: callbackToken,
    CAT_CAFE_USER_ID: userId,
    CAT_CAFE_CAT_ID: catId,
    // F061 Bug-F cold-start (codex peer review on 47922fe7): cat_cafe_list_session_chain
    // requires threadId; without it, Bengal's cold-start prompt step 1 fails with
    // "missing required parameter". Inject the live threadId so prompt template
    // can resolve to a concrete value.
    CAT_CAFE_THREAD_ID: threadId,
    ...(process.env.CAT_CAFE_SIGNAL_USER ? { CAT_CAFE_SIGNAL_USER: process.env.CAT_CAFE_SIGNAL_USER } : {}),
    // Per-cat git author identity (W1: cats are Agents with identity).
    // GIT_AUTHOR_NAME/GIT_COMMITTER_NAME override the runtime git config's pinned
    // user.name so each cat's commits carry its own name instead of all collapsing
    // to one. Model comes from getCatModel(catId) — the SAME source as the system-prompt
    // identity line (env CAT_{CATID}_MODEL > runtime catRegistry), so the author name
    // tracks the cat's real model (opus-45 → claude-opus-4-8), not the catId or a stale
    // catalog copy. Email is intentionally NOT set — it inherits git config (the operator's
    // GitHub noreply account) so contribution-graph attribution stays on one account
    // while the name distinguishes the cat. (operator directive 2026-05-28)
    ...buildCatGitIdentityEnv(
      catId as string,
      catRegistry.tryGet(catId as string)?.config?.breedId,
      ((): string | undefined => {
        try {
          return getCatModel(catId as string);
        } catch {
          return undefined;
        }
      })(),
    ),
  };

  const auditLog = getEventAuditLog();
  const promptDigest = createPromptDigest(prompt);
  const startTime = Date.now();

  let threadCreatedAt: number | undefined;

  // F118 AC-C5: Flags for finally block fallback audit (must be before any early return)
  let hadError = false;
  let didWriteAudit = false;
  let didComplete = false;
  let didResetRestoreFailures = false;
  let openCodeRuntimeConfigPath: string | undefined;
  const hostProjectRoot = findMonorepoRoot(process.cwd());

  // === CAT_INVOKED 审计 (fire-and-forget, 缅因猫 review P2-3) ===
  auditLog
    .append({
      type: AuditEventTypes.CAT_INVOKED,
      threadId,
      data: {
        catId,
        userId,
        invocationId,
        promptDigest,
        isLastCat,
      },
    })
    .catch((err) => {
      // P2-2: 打印完整错误信息 + 上下文
      log.warn({ threadId, invocationId, err }, 'CAT_INVOKED audit write failed');
    });

  let hadStreamError = false;
  let lastTasks: TaskProgressItem[] | null = null;
  let terminalTaskProgressStatus: TaskProgressStatus | null = null;
  let terminalInterruptReason: 'error' | 'aborted' | null = null;
  let finalizedTaskProgressStatus: TaskProgressStatus | null = null;

  const attachInvocationIdToTaskProgress = (message: AgentMessage): AgentMessage => {
    if (message.type !== 'system_info' || !message.content) return message;
    try {
      const parsed = JSON.parse(message.content) as Record<string, unknown>;
      if (parsed.type !== 'task_progress' || typeof parsed.invocationId === 'string') return message;
      return {
        ...message,
        content: JSON.stringify({ ...parsed, invocationId }),
      };
    } catch {
      return message;
    }
  };

  const maybePersistTaskProgress = async (out: AgentMessage): Promise<void> => {
    if (!deps.taskProgressStore) return;
    if (out.type !== 'system_info' || !out.content) return;
    let tasks: TaskProgressItem[] | null = null;
    try {
      const parsed = JSON.parse(out.content) as { type?: string; tasks?: unknown };
      if (parsed.type !== 'task_progress' || !Array.isArray(parsed.tasks)) return;
      tasks = parsed.tasks as TaskProgressItem[];
      lastTasks = tasks;
    } catch {
      return;
    }

    try {
      await deps.taskProgressStore.setSnapshot({
        threadId,
        catId,
        tasks,
        status: 'running',
        updatedAt: Date.now(),
        lastInvocationId: invocationId,
      });
    } catch (err) {
      log.warn({ threadId, catId, invocationId, err }, 'Task progress persist running snapshot failed');
    }
  };

  const finalizeTaskProgress = async (): Promise<void> => {
    if (!deps.taskProgressStore || !lastTasks) return;
    const wasAborted = Boolean(signal?.aborted);

    // Determine the terminal status once per invocation and keep it stable.
    // In particular: if we already reached a successful terminal (`done` without error),
    // later `AbortSignal` flips (client disconnect / iterator.return()) must NOT
    // downgrade the snapshot to `interrupted`.
    const status: TaskProgressStatus =
      terminalTaskProgressStatus ?? (hadError || wasAborted ? 'interrupted' : 'completed');
    const interruptReason =
      terminalInterruptReason ??
      (status === 'interrupted' ? (hadError ? 'error' : wasAborted ? 'aborted' : undefined) : undefined);

    // Once we have persisted a "completed" snapshot, don't downgrade it to
    // "interrupted" just because the request was aborted after completion
    // (e.g. client disconnect / iterator.return()).
    if (finalizedTaskProgressStatus === 'completed' && status === 'interrupted' && !hadError) return;
    // Similarly, don't upgrade an interrupted snapshot back to completed.
    if (finalizedTaskProgressStatus === 'interrupted' && status === 'completed') return;
    if (finalizedTaskProgressStatus === status) return;

    try {
      await deps.taskProgressStore.setSnapshot({
        threadId,
        catId,
        tasks: lastTasks,
        status,
        updatedAt: Date.now(),
        lastInvocationId: invocationId,
        ...(interruptReason ? { interruptReason } : {}),
      });
      finalizedTaskProgressStatus = status;
    } catch (err) {
      log.warn({ threadId, catId, invocationId, status, err }, 'Task progress persist final snapshot failed');
    }
  };

  // F118: Declared before try so it's accessible in finally
  let sessionMutexRelease: (() => void) | undefined;

  // F152: Create invocation span for distributed tracing
  // F153 Phase E: If a route span exists, make invocation its child
  const parentCtx = params.routeSpan ? trace.setSpan(context.active(), params.routeSpan) : undefined;
  const invocationSpan = tracer.startSpan(
    'cat_cafe.invocation',
    { attributes: { [AGENT_ID]: catId, [OPERATION_NAME]: 'invoke', invocationId } },
    parentCtx,
  );

  // F153 Phase J AC-J3: per-invocation tool span tracker (real-duration MCP tool spans).
  // Used when provider emits toolUseId; falls back to legacy recordToolUseSpan when not.
  const toolSpanTracker = new ToolSpanTracker(invocationSpan, catId as string);

  // F153: Expose invocation span to caller + persist trace context for A2A propagation
  if (params.invocationSpanRef) params.invocationSpanRef.current = invocationSpan;
  const sc = invocationSpan.spanContext();
  try {
    if (typeof deps.registry.setTraceContext === 'function') {
      await deps.registry.setTraceContext(invocationId, {
        traceId: sc.traceId,
        spanId: sc.spanId,
        traceFlags: sc.traceFlags,
      });
    }
  } catch (err) {
    log.warn({ catId, threadId, invocationId, err }, 'Trace context persistence failed, continuing invocation');
  }

  try {
    // F152: Track active invocations — must be inside try so add/sub symmetry
    // is guaranteed by the finally block, even on generator early abort.
    activeInvocations.add(1, { [AGENT_ID]: catId, [OPERATION_NAME]: 'invoke' });

    // F152: Emit invocation start through OTel log pipeline
    emitOtelLog('INFO', 'invocation_started', { [AGENT_ID]: catId, [OPERATION_NAME]: 'invoke' }, invocationSpan);

    let sessionId: string | undefined;
    try {
      sessionId = await preflightRace(sessionManager.get(userId, catId, threadId), 'sessionManager.get', signal);
    } catch (err) {
      // Redis read failure or preflight timeout — continue without session
      log.warn({ catId, threadId, invocationId, err }, 'Session get failed (timeout or Redis), proceeding without');
    }

    // R8 P1: Read-side short-circuit — if sessionChainStore has sealed/sealing sessions
    // but NO active session, the previous session was sealed. Discard the persisted CLI
    // sessionId to prevent --resume into a sealed session. This eliminates the race
    // window between fire-and-forget delete and next get().
    // Only applies when chain is non-empty (empty chain = fresh thread, keep sessionId).
    //
    // R11 P1-1: When active record exists, its cliSessionId is the authoritative value.
    // sessionManager.get() may return a stale value if session_init updated the record
    // but sessionManager wasn't re-written. Always align to the active record.
    //
    // F33-fix: Always check chain even when sessionManager returns nothing.
    // The PATCH bind endpoint writes to sessionChainStore but not sessionManager,
    // so a freshly-bound session would be missed if we gate on sessionId being truthy.
    const sessionChainActive = isSessionChainEnabled(catId);
    if (isBgCarrier && bgChainKey && deps.sessionChainStore && sessionChainActive) {
      // F198 Bug #3: bg resolves its resume target via the chainKey record's
      // latestResumeSessionId (the daemon's previous fork UUID). bg reuses one
      // record across daemon rotation instead of seal+create — but still
      // respects an EXTERNAL seal (manual / threshold / reaper): a sealed record
      // must NOT be resumed (mirrors the non-bg "no active → no resume" path).
      try {
        const bgRec = await preflightRace(
          Promise.resolve(deps.sessionChainStore.getByChainKey(bgChainKey)),
          'getByChainKey',
          signal,
        );
        // Cloud review P1: only resume an ACTIVE bg record — start fresh if sealed.
        sessionId = bgRec?.status === 'active' ? bgRec.latestResumeSessionId : undefined;
      } catch {
        // Fail-closed: start fresh if the chainKey read fails.
        sessionId = undefined;
      }
    } else if (deps.sessionChainStore && sessionChainActive) {
      // Reaper: reconcile any sessions stuck in 'sealing' > 5 minutes (best-effort).
      if (deps.sessionSealer) {
        try {
          await preflightRace(deps.sessionSealer.reconcileStuck(catId, threadId), 'reconcileStuck', signal);
        } catch {
          /* best-effort reconcile — timeout or error */
        }
      }
      try {
        const chain = await preflightRace(
          Promise.resolve(deps.sessionChainStore.getChain(catId, threadId)),
          'getChain',
          signal,
        );
        if (chain.length > 0) {
          const activeRec = chain.find((s) => s.status === 'active');
          if (!activeRec) {
            // Chain exists but no active session → previous was sealed; don't resume
            sessionId = undefined;
          } else if (activeRec.cliSessionId) {
            // F118 AC-C6: Overflow circuit breaker — too many consecutive restore failures (#86)
            // Note: time-based "stale" check removed — idle sessions are healthy,
            // only repeated restore failures indicate a toxic session.
            const MAX_CONSECUTIVE_FAILURES = 3;
            const isOverflow = (activeRec.consecutiveRestoreFailures ?? 0) >= MAX_CONSECUTIVE_FAILURES;
            if (isOverflow && deps.sessionSealer) {
              let sealOk = false;
              try {
                const result = await preflightRace(
                  deps.sessionSealer.requestSeal({ sessionId: activeRec.id, reason: 'overflow_circuit_breaker' }),
                  'requestSeal',
                  signal,
                );
                sealOk = result.accepted;
                if (sealOk) {
                  // Must finalize to write transcript + digest to disk,
                  // otherwise session recall tools get 404 (no data on disk).
                  deps.sessionSealer.finalize({ sessionId: activeRec.id }).catch(() => {});
                }
              } catch {
                /* best-effort seal */
              }
              // Only drop sessionId if seal succeeded — otherwise resume with existing
              if (sealOk) {
                sessionId = undefined;
              } else {
                sessionId = activeRec.cliSessionId;
              }
            } else {
              // Active record's cliSessionId is authoritative (includes F33 manual bind)
              sessionId = activeRec.cliSessionId;
            }
          }
        }
      } catch {
        // R9 P1: Fail-closed — if chain store read fails, discard sessionId.
        // Rationale: requestSeal accepted = hard seal boundary. When we can't
        // verify chain state, it's safer to start fresh than risk --resume
        // into a sealed session. Lost resume is recoverable; sealed-session
        // corruption is not.
        sessionId = undefined;
      }
    }

    // F118: Acquire per-conversation mutex to prevent concurrent resume.
    // F198 Bug #3: bg keys on the stable chainKey — sessionId rotates per daemon
    // fork, so keying on it would let two `--resume` turns race. Non-bg keeps
    // the cliSessionId key unchanged.
    const mutexKey = isBgCarrier && bgChainKey ? bgChainKey : sessionId;
    if (mutexKey) {
      try {
        sessionMutexRelease = await sessionMutex.acquire(mutexKey, signal);
      } catch (err) {
        // Abort while queued is not a runtime error — clean exit
        if (signal?.aborted) {
          const sc = invocationSpan.spanContext();
          const parentSid = params.routeSpan?.spanContext().spanId;
          yield {
            type: 'done' as const,
            catId,
            isFinal: isLastCat,
            timestamp: Date.now(),
            tracing: { traceId: sc.traceId, spanId: sc.spanId, ...(parentSid ? { parentSpanId: parentSid } : {}) },
          };
          didComplete = true; // F118 AC-C5: Abort early exit, not force-return
          return;
        }
        throw err; // unexpected error — let outer catch handle
      }
    }

    // Resolve workingDirectory from thread's projectPath
    let workingDirectory: string | undefined;
    let bootcampWorkspaceError: Error | undefined;
    if (threadStore) {
      try {
        const thread = await preflightRace(Promise.resolve(threadStore.get(threadId)), 'threadStore.get', signal);
        if (thread?.createdAt) threadCreatedAt = thread.createdAt;
        // #836: Reborn session strategy — force new session every invocation.
        // Uses store lookup (isRebornSession) instead of thread field because
        // Redis stores strategy in separate hash fields not hydrated by get().
        // Optional chaining: test mocks may omit isRebornSession (absent = false).
        // Best-effort: a transient Redis failure must not skip workspace resolution
        // below — wrap in its own try/catch, defaulting to non-reborn.
        let isReborn = false;
        try {
          isReborn = threadStore.isRebornSession
            ? await preflightRace(
                Promise.resolve(threadStore.isRebornSession(threadId, catId as string)),
                'isRebornSession',
                signal,
              )
            : false;
        } catch (rebornErr) {
          log.warn(
            { catId, threadId, err: rebornErr },
            '#836: isRebornSession lookup failed pre-invoke, defaulting to non-reborn',
          );
        }
        if (isReborn) {
          sessionId = undefined;
          log.info({ catId, threadId }, '#836: reborn session strategy — forcing new session');
        }
        if (thread?.projectPath && thread.projectPath !== 'default') {
          // F101: Game threads use virtual projectPaths (e.g. 'games/werewolf') for
          // categorization only — they are not real filesystem directories. Skip them
          // to avoid triggering the F070 governance gate on a non-existent path.
          if (!thread.projectPath.startsWith('games/') && isUnderAllowedRoot(thread.projectPath)) {
            workingDirectory = thread.projectPath;
          }
        } else if (thread?.bootcampState) {
          const bootcampWorkspace = await resolveBootcampWorkspaceRoot();
          if (bootcampWorkspace.ok) {
            workingDirectory = bootcampWorkspace.projectPath;
          } else {
            bootcampWorkspaceError = new Error(bootcampWorkspace.error);
          }
        }
      } catch {
        // Thread store timeout or error — proceed without workingDirectory
      }
    }
    if (bootcampWorkspaceError) {
      throw bootcampWorkspaceError;
    }
    const workingProjectRoot = workingDirectory ? findMonorepoRoot(workingDirectory) : undefined;

    // Shared-state preflight — covers ALL cats (Claude/Codex/Gemini), vendor-agnostic.
    // Three-layer defense model (shared-rules §14):
    //   L1 .githooks/pre-commit = hard block (prevents committing on wrong branch)
    //   L2 this check = see below
    //   L3 CI guard = hard block (prevents merging PRs with shared-state changes)
    //
    // Scope: only check the host Clowder AI repo (or its worktrees). External projects /
    // fork playgrounds may be routed by this runtime, but they must not inherit
    // shared-state warnings from the repo that launched the API process.
    if (
      process.env.CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT !== '1' &&
      (!workingProjectRoot || isSameProject(workingProjectRoot, hostProjectRoot))
    ) {
      // L2 behavior is warn-only during interactive invocation. Hard safety still lives
      // in L1/L3 (`pre-commit` + CI / merge gate); blocking regular chat invocations on
      // local git state made multi-cat routing unusable whenever shared-state lagged.
      try {
        const { checkSharedStatePreflight } = await import('../../../../../config/shared-state-preflight.js');
        const preflightRoot = workingProjectRoot ?? hostProjectRoot;
        const ssCheck = checkSharedStatePreflight(preflightRoot);
        if (!ssCheck.ok) {
          if (ssCheck.unpushedFiles?.length) {
            const msg =
              `Shared-state files committed but not pushed: ${ssCheck.unpushedFiles.join(', ')}. ` +
              'Please `git push` soon so other cats see the latest shared state (shared-rules §14).';
            log.warn(
              { catId, preflightRoot, unpushedFiles: ssCheck.unpushedFiles },
              'Shared-state preflight: unpushed files',
            );
            yield {
              type: 'system_info' as const,
              catId,
              content: `⚠️ ${msg}`,
              timestamp: Date.now(),
            };
          }
          if (ssCheck.uncommittedFiles?.length) {
            const msg = `uncommitted shared-state files: ${ssCheck.uncommittedFiles.join(', ')}`;
            log.warn(
              { catId, preflightRoot, uncommittedFiles: ssCheck.uncommittedFiles },
              'Shared-state preflight: uncommitted files',
            );
            yield {
              type: 'system_info' as const,
              catId,
              content: `⚠️ Shared-state preflight: ${msg}. Please commit+push before continuing (shared-rules §14).`,
              timestamp: Date.now(),
            };
          }
        }
      } catch {
        // Don't block on preflight errors
      }
    }

    // F070: Governance gate for external project dispatch
    if (workingDirectory && !isSameProject(workingDirectory, hostProjectRoot)) {
      const catCafeRoot = hostProjectRoot;
      const { tryGovernanceBootstrap } = await import('../../../../../config/capabilities/capability-orchestrator.js');
      await tryGovernanceBootstrap(workingDirectory, catCafeRoot);
      const { checkGovernancePreflight } = await import('../../../../../config/governance/governance-preflight.js');
      const catEntry = catRegistry.tryGet(catId as string);
      const preflight = await checkGovernancePreflight(workingDirectory, catCafeRoot, catEntry?.config.clientId);
      if (!preflight.ready) {
        const reasonKind = preflight.needsBootstrap
          ? 'needs_bootstrap'
          : preflight.needsConfirmation
            ? 'needs_confirmation'
            : 'files_missing';
        // F070: Structured governance_blocked event — frontend renders actionable card
        yield {
          type: 'system_info',
          catId,
          content: JSON.stringify({
            type: 'governance_blocked',
            projectPath: workingDirectory,
            reasonKind,
            reason: preflight.reason,
            invocationId: params.parentInvocationId,
          }),
          timestamp: Date.now(),
        };
        // F070: done with errorCode so routes mark invocation as failed (retryable)
        yield {
          type: 'done',
          catId,
          isFinal: params.isLastCat,
          errorCode: 'GOVERNANCE_BOOTSTRAP_REQUIRED',
          timestamp: Date.now(),
        };
        didComplete = true;
        return;
      }
    }

    // F070 Phase 2: Inject dispatch mission context for external projects
    let missionPrefix = '';
    let capturedMissionPack: import('@cat-cafe/shared').DispatchMissionPack | undefined;
    if (workingDirectory && !isSameProject(workingDirectory, hostProjectRoot) && threadStore) {
      try {
        const thread = await preflightRace(
          Promise.resolve(threadStore.get(threadId)),
          'threadStore.get:mission',
          signal,
        );
        if (thread) {
          const { buildMissionPack, formatMissionPackPrompt } = await import(
            '../../../../../config/governance/mission-pack.js'
          );
          capturedMissionPack = buildMissionPack({
            title: thread.title ?? undefined,
            phase: thread.phase ?? undefined,
            backlogItemId: thread.backlogItemId ?? undefined,
          });
          missionPrefix = formatMissionPackPrompt(capturedMissionPack);
        }
      } catch {
        // Thread store timeout — proceed without mission context
      }
    }

    // F127 account injection:
    // Members bind to a concrete accountRef (builtin oauth account or generic api_key account).
    const catConfig = catRegistry.tryGet(catId as string)?.config;
    const provider = catConfig?.clientId;
    const builtinClient = provider ? resolveBuiltinClientForProvider(provider) : null;
    const defaultModel = catConfig?.defaultModel?.trim() || undefined;
    // Account resolution, proxy registration, and runtime config always use the
    // runtime root (process.cwd()), NOT thread.projectPath.  catRegistry loads
    // from the runtime root at startup — reading a divergent catalog (e.g. the
    // dev worktree pointed to by thread.projectPath) misses runtime-only accounts.
    // workingProjectRoot is still used for shared-state preflight + cat cwd.
    const projectRoot = resolveActiveProjectRoot(process.cwd());
    const effectiveAccountRef = resolveBoundAccountRefForCat(projectRoot, catId, catConfig);
    const resolveRuntimeAccount = async () => {
      if (!builtinClient) return null;
      // Yield to event loop so preflight warnings are delivered before account resolution.
      await Promise.resolve();
      const runtime = resolveForClient(projectRoot, builtinClient, effectiveAccountRef);
      if (effectiveAccountRef && !runtime) {
        throw new Error(`bound account "${effectiveAccountRef}" not found`);
      }
      return runtime;
    };
    const assertCompatibleRuntimeAccount = <T extends { id: string }>(
      account: (T & Parameters<typeof validateRuntimeProviderBinding>[1]) | null,
    ) => {
      if (!provider || !account) return account;
      const compatibilityError = validateRuntimeProviderBinding(provider, account, defaultModel);
      if (compatibilityError) {
        throw new Error(compatibilityError);
      }
      return account;
    };
    const isExplicitBindingCompatibilityError = (err: unknown): err is Error =>
      err instanceof Error &&
      (/bound provider profile/i.test(err.message) || /model ".+" is not available on provider/i.test(err.message));
    const isBoundAccountResolutionError = (err: unknown): err is Error =>
      err instanceof Error && /bound account ".+" not found/i.test(err.message);

    // Resolve account first, then use its protocol for env injection.
    // For API Key accounts, protocol is declared on the account itself.
    // For builtin OAuth accounts, protocol comes from the provider mapping.
    let resolvedAccount: Awaited<ReturnType<typeof resolveRuntimeAccount>> = null;
    try {
      resolvedAccount = assertCompatibleRuntimeAccount(await resolveRuntimeAccount());
    } catch (err) {
      if (isExplicitBindingCompatibilityError(err) || isBoundAccountResolutionError(err)) {
        throw err;
      }
      if (effectiveAccountRef) {
        throw new Error(`failed to resolve bound account "${effectiveAccountRef}"`);
      }
    }

    // Fail fast when an api_key account has no credential — otherwise the child
    // process silently receives no auth and produces cryptic errors.
    if (resolvedAccount?.authType === 'api_key' && !resolvedAccount.apiKey) {
      throw new Error(
        `account "${resolvedAccount.id}" is configured as api_key but has no API key set — ` +
          'add the key in Hub > account settings',
      );
    }

    // clowder-ai#340: Protocol is fully derived from client/provider identity — account.protocol retired.
    // Non-opencode clients have a fixed protocol. OpenCode derives protocol from the
    // variant's model provider name or model string prefix, defaulting to anthropic.
    const protocolForProvider: Record<string, string> = {
      anthropic: 'anthropic',
      openai: 'openai',
      google: 'google',
      kimi: 'kimi',
      dare: 'openai',
      opencode: 'anthropic',
      openrouter: 'openai',
    };
    let effectiveProtocol: string | null = provider ? (protocolForProvider[provider] ?? null) : null;
    if (provider === 'opencode') {
      // Priority 1: explicit variant.provider field
      const modelProviderHint = catConfig?.provider?.trim();
      if (modelProviderHint && protocolForProvider[modelProviderHint]) {
        effectiveProtocol = protocolForProvider[modelProviderHint];
      } else {
        // Priority 2: model string prefix (e.g. 'openrouter/google/model' → openrouter → openai)
        const trimmedModel = typeof defaultModel === 'string' ? defaultModel.trim() : '';
        const parsed = trimmedModel ? parseOpenCodeModel(trimmedModel) : null;
        if (parsed && protocolForProvider[parsed.providerName]) {
          effectiveProtocol = protocolForProvider[parsed.providerName];
        }
      }
    }

    // effectiveProtocol is used below for env injection branching (anthropic/openai/google)
    // but is NOT passed to callbackEnv — it should not influence CLI routing decisions.

    if (effectiveProtocol === 'anthropic') {
      if (resolvedAccount?.authType === 'api_key') {
        callbackEnv.CAT_CAFE_ANTHROPIC_PROFILE_MODE = 'api_key';
        if (resolvedAccount.apiKey) callbackEnv.CAT_CAFE_ANTHROPIC_API_KEY = resolvedAccount.apiKey;
        if (resolvedAccount.models?.length && provider !== 'opencode') {
          callbackEnv.CAT_CAFE_ANTHROPIC_MODEL_OVERRIDE = resolvedAccount.models[0];
        }
        if (resolvedAccount.baseUrl) {
          const proxyPortStr = process.env.ANTHROPIC_PROXY_PORT || '9877';
          const proxyPortNum = parseInt(proxyPortStr, 10);
          const proxyEnabled = process.env.ANTHROPIC_PROXY_ENABLED !== '0';
          if (proxyEnabled && !Number.isNaN(proxyPortNum) && proxyPortNum > 0 && proxyPortNum <= 65535) {
            const proxyAlive = await tcpProbe('127.0.0.1', proxyPortNum);
            if (proxyAlive) {
              const slug = deriveProxySlug(resolvedAccount.id);
              registerProxyUpstream(projectRoot, slug, resolvedAccount.baseUrl);
              callbackEnv.CAT_CAFE_ANTHROPIC_BASE_URL = `http://127.0.0.1:${proxyPortStr}/${slug}`;
            } else {
              log.warn(
                { proxyPort: proxyPortStr, baseUrl: resolvedAccount.baseUrl },
                'Proxy unreachable, falling back to direct upstream',
              );
              callbackEnv.CAT_CAFE_ANTHROPIC_BASE_URL = resolvedAccount.baseUrl;
            }
          } else {
            if (proxyEnabled && (Number.isNaN(proxyPortNum) || proxyPortNum <= 0 || proxyPortNum > 65535)) {
              log.warn({ proxyPort: proxyPortStr }, 'Invalid ANTHROPIC_PROXY_PORT, falling back to direct upstream');
            }
            callbackEnv.CAT_CAFE_ANTHROPIC_BASE_URL = resolvedAccount.baseUrl;
          }
        }
      } else {
        callbackEnv.CAT_CAFE_ANTHROPIC_PROFILE_MODE = 'subscription';
      }
    } else if (effectiveProtocol === 'openai' || effectiveProtocol === 'openai-responses') {
      if (resolvedAccount?.authType === 'api_key') {
        callbackEnv.CODEX_AUTH_MODE = 'api_key';
        if (resolvedAccount.apiKey) {
          callbackEnv.OPENAI_API_KEY = resolvedAccount.apiKey;
          // OpenCode selects provider by model prefix; `openrouter/...` models require this key name.
          callbackEnv.OPENROUTER_API_KEY = resolvedAccount.apiKey;
        }
        if (resolvedAccount.baseUrl) {
          callbackEnv.OPENAI_BASE_URL = resolvedAccount.baseUrl;
          callbackEnv.OPENAI_API_BASE = resolvedAccount.baseUrl;
        }
      } else if (effectiveAccountRef) {
        callbackEnv.CODEX_AUTH_MODE = 'oauth';
      }
    } else if (effectiveProtocol === 'google') {
      if (resolvedAccount?.authType === 'api_key' && resolvedAccount.apiKey) {
        // Gemini CLI: native Google SDK, uses GEMINI_API_KEY
        callbackEnv.GEMINI_API_KEY = resolvedAccount.apiKey;
        callbackEnv.GOOGLE_API_KEY = resolvedAccount.apiKey;
        // opencode CLI: OpenRouter provider uses OPENROUTER_API_KEY
        callbackEnv.OPENROUTER_API_KEY = resolvedAccount.apiKey;
        if (resolvedAccount.baseUrl) {
          callbackEnv.GEMINI_BASE_URL = resolvedAccount.baseUrl;
        }
      }
    } else if (effectiveProtocol === 'kimi') {
      if (resolvedAccount?.authType === 'api_key' && resolvedAccount.apiKey) {
        callbackEnv.CAT_CAFE_KIMI_PROFILE_MODE = 'api_key';
        callbackEnv.CAT_CAFE_KIMI_API_KEY = resolvedAccount.apiKey;
        callbackEnv.MOONSHOT_API_KEY = resolvedAccount.apiKey;
        if (resolvedAccount.baseUrl) {
          callbackEnv.CAT_CAFE_KIMI_BASE_URL = resolvedAccount.baseUrl;
        }
      } else {
        callbackEnv.CAT_CAFE_KIMI_PROFILE_MODE = 'subscription';
      }
    } else if (provider === 'anthropic' || provider === 'opencode') {
      // Fallback for unresolved accounts on anthropic/opencode providers
      callbackEnv.CAT_CAFE_ANTHROPIC_PROFILE_MODE = 'subscription';
    }

    // Dare has its own env vars regardless of protocol-based injection above
    if (provider === 'dare' && resolvedAccount?.authType === 'api_key') {
      if (resolvedAccount.apiKey) callbackEnv.DARE_API_KEY = resolvedAccount.apiKey;
      if (resolvedAccount.baseUrl) callbackEnv.DARE_ENDPOINT = resolvedAccount.baseUrl;
    }

    // F171: User-defined env vars from account config.
    // Passed separately via accountEnv — NOT injected into callbackEnv.
    // callbackEnv is for MCP callback routing; accountEnv is applied LAST
    // in subprocess env so user vars override provider-injected values.
    let accountEnv: Record<string, string> | undefined;
    if (resolvedAccount?.envVars) {
      const validEnvKey = /^[A-Z_][A-Za-z0-9_]*$/;
      const filtered: Record<string, string> = {};
      for (const [k, v] of Object.entries(resolvedAccount.envVars)) {
        if (!validEnvKey.test(k) || k.startsWith('CAT_CAFE_')) continue;
        filtered[k] = v;
      }
      if (Object.keys(filtered).length > 0) accountEnv = filtered;
    }

    const trimmedDefaultModel = typeof defaultModel === 'string' ? defaultModel.trim() : undefined;
    const modelProviderName = catConfig?.provider?.trim() || undefined;
    const parsedOpenCodeModel =
      provider === 'opencode' && trimmedDefaultModel ? parseOpenCodeModel(trimmedDefaultModel) : null;
    // clowder-ai#223 intake: determine effective provider + model.
    // Three cases for defaultModel shape:
    //   1. Canonical "provider/model" where parsed provider === modelProviderName → use as-is
    //   2. Namespaced "ns/model" where parsed prefix ≠ modelProviderName → prefix with modelProviderName
    //   3. Bare "model" → prefix with modelProviderName if available
    // When modelProviderName is absent, parseOpenCodeModel is the sole source.
    let effectiveProviderName: string | undefined;
    let effectiveModel: string | undefined;
    if (parsedOpenCodeModel) {
      if (modelProviderName && parsedOpenCodeModel.providerName !== modelProviderName) {
        // Namespace case: model's "/" is a namespace separator, not provider prefix
        effectiveProviderName = modelProviderName;
        effectiveModel = `${modelProviderName}/${trimmedDefaultModel}`;
      } else {
        // Canonical provider/model (with or without matching modelProviderName)
        effectiveProviderName = modelProviderName || parsedOpenCodeModel.providerName;
        effectiveModel = trimmedDefaultModel!;
      }
    } else if (modelProviderName && trimmedDefaultModel) {
      // Bare model + modelProviderName fallback
      effectiveProviderName = modelProviderName;
      effectiveModel = `${modelProviderName}/${trimmedDefaultModel}`;
    }

    if (provider === 'opencode') {
      log.debug(
        {
          catId,
          invocationId,
          boundAccountRef: effectiveAccountRef ?? null,
          resolvedAccount: resolvedAccount
            ? {
                id: resolvedAccount.id,
                authType: resolvedAccount.authType,
                baseUrl: resolvedAccount.baseUrl ?? null,
                modelCount: resolvedAccount.models?.length ?? 0,
                hasApiKey: Boolean(resolvedAccount.apiKey),
              }
            : null,
          defaultModel: trimmedDefaultModel ?? null,
          modelProviderName: modelProviderName ?? null,
          parsedOpenCodeModel,
          effectiveProviderName: effectiveProviderName ?? null,
          effectiveModel: effectiveModel ?? null,
        },
        'Resolved OpenCode runtime inputs',
      );
    }
    // fix(#280): explicit provider name means we must force the clowder-ai#223 path so the
    // effective "provider/model" string is injected into opencode, even for builtin
    // providers. For legacy members without provider name, only synthesize runtime
    // config when the fully-qualified model is not already routable by `opencode models`.
    //
    // MCP injection: even known models need a runtime config to get deterministic
    // Clowder AI MCP server access (especially in game threads where project-level
    // opencode.json may not be discoverable).
    const hasExplicitOcProvider = Boolean(modelProviderName);
    const configuredMcpServerPath = process.env.CAT_CAFE_MCP_SERVER_PATH?.trim();
    const mcpServerPath = configuredMcpServerPath
      ? resolve(process.cwd(), configuredMcpServerPath)
      : resolveDefaultClaudeMcpServerPath();

    // F203 Phase I: compile L0 for OpenCode BEFORE the runtime config condition.
    // OpenCodeAgentService.injectsL0Natively() = true, so the route layer does
    // pack-only. We MUST ensure every OpenCode invocation path gets compiled L0
    // in the runtime config's instructions array — otherwise the cat loses its
    // identity/governance/roster post-compaction (砚砚 P1 guard).
    //
    // The L0 file is written into the per-invocation config dir (P2: no separate
    // dir leak — cleaned up together with the runtime config in finally).
    let openCodeL0InstructionPaths: string[] | undefined;
    if (provider === 'opencode') {
      try {
        // Use service's injectable l0CompilerFn if available (test seam, like Claude/Codex),
        // otherwise fall back to the subprocess compiler (production path).
        // l0CompilerFn via typed guard (no `any` — L0InjectableAgentService in types.ts).
        // hasL0CompilerSeam guarantees l0CompilerFn is a function (type guard checks typeof),
        // but TS narrows to `L0CompilerFn | undefined`. Use `?? compileL0ViaSubprocess` as
        // the undefined branch is unreachable post-guard — avoids biome noNonNullAssertion.
        const compilerFn = (hasL0CompilerSeam(service) && service.l0CompilerFn) || compileL0ViaSubprocess;

        const l0Content = await compilerFn({ catId: catId as string });
        // Write compiled L0 into the runtime config dir (created below or reused).
        const safeCatId = (catId as string).replace(/[^a-zA-Z0-9._-]+/g, '-');
        const safeInvocationId = invocationId.replace(/[^a-zA-Z0-9._-]+/g, '-');
        const configDir = join(projectRoot, '.cat-cafe', `oc-config-${safeCatId}-${safeInvocationId}`);
        mkdirSync(configDir, { recursive: true });
        const l0Path = join(configDir, 'system-prompt-l0.md');
        writeFileSync(l0Path, l0Content, 'utf8');
        // Resolve OPENCODE.md from project root (OpenCode-specific addendum: question deny, interaction channel).
        const opencodeInstructionsPath = resolve(projectRoot, 'OPENCODE.md');
        openCodeL0InstructionPaths = [l0Path, opencodeInstructionsPath];
        log.debug(
          { catId, invocationId, l0Path, opencodeInstructionsPath, l0Bytes: l0Content.length },
          'Compiled L0 for OpenCode (F203 Phase I)',
        );
      } catch (err) {
        // Fail-closed: L0 compilation failure = cat invocation without identity is dangerous.
        // Log and throw — do not proceed with a naked invocation.
        log.error(
          { catId, invocationId, err: err instanceof Error ? err.message : String(err) },
          'F203 Phase I: L0 compilation failed for OpenCode — fail-closed, aborting invocation',
        );
        throw new Error(
          `F203 fail-closed: cannot compile L0 for OpenCode cat ${catId as string}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // authType is either 'api_key' or 'oauth' — both need runtime config (MCP +
    // L0 + model routing). The only difference is credential injection below.
    const isApiKey = resolvedAccount?.authType === 'api_key';
    if (
      provider === 'opencode' &&
      resolvedAccount != null &&
      effectiveModel &&
      effectiveProviderName &&
      (hasExplicitOcProvider || !getOpenCodeKnownModels().has(effectiveModel) || mcpServerPath)
    ) {
      // Remap model prefix when provider name collides with OpenCode builtins
      // (e.g. 'openai/gpt-4o' → 'openai-compat/gpt-4o') so the CLI -m arg
      // matches the remapped provider key in opencode.json.
      const safeProvider = safeProviderName(effectiveProviderName);
      const safeModel =
        safeProvider !== effectiveProviderName && effectiveModel.startsWith(`${effectiveProviderName}/`)
          ? `${safeProvider}/${effectiveModel.slice(effectiveProviderName.length + 1)}`
          : effectiveModel;
      callbackEnv.CAT_CAFE_ANTHROPIC_MODEL_OVERRIDE = safeModel;
      const apiType = deriveOpenCodeApiType(effectiveProviderName);
      const rawModels = resolvedAccount.models?.length ? resolvedAccount.models : [effectiveModel];
      const runtimeConfigOptions = {
        providerName: effectiveProviderName,
        models: rawModels,
        defaultModel: effectiveModel,
        apiType,
        hasBaseUrl: Boolean(resolvedAccount.baseUrl),
        omitProviderAuth: !isApiKey,
        mcpServerPath,
        // F203 Phase I: inject compiled L0 + OPENCODE.md into instructions.
        instructions: openCodeL0InstructionPaths,
      } as const;
      openCodeRuntimeConfigPath = writeOpenCodeRuntimeConfig(
        projectRoot,
        catId as string,
        invocationId,
        runtimeConfigOptions,
      );
      callbackEnv.OPENCODE_CONFIG = openCodeRuntimeConfigPath;
      // Credentials: only for api_key auth.
      // OAuth users authenticate through OpenCode's native flow; their runtime
      // config omits provider auth placeholders and signals buildEnv to preserve
      // native auth instead of clearing it for the custom provider config path.
      if (isApiKey) {
        if (resolvedAccount.apiKey) callbackEnv[OC_API_KEY_ENV] = resolvedAccount.apiKey;
        if (resolvedAccount.baseUrl) callbackEnv[OC_BASE_URL_ENV] = resolvedAccount.baseUrl;
      } else {
        callbackEnv[OC_INSTRUCTIONS_ONLY_ENV] = '1';
      }
      log.debug(
        {
          catId,
          invocationId,
          openCodeConfigPath: openCodeRuntimeConfigPath,
          apiType,
          callbackEnvSummary: {
            opencodeConfig: callbackEnv.OPENCODE_CONFIG,
            ocBaseUrl: callbackEnv[OC_BASE_URL_ENV] ?? null,
            ocApiKeyPresent: Boolean(callbackEnv[OC_API_KEY_ENV]),
            modelOverride: callbackEnv.CAT_CAFE_ANTHROPIC_MODEL_OVERRIDE ?? null,
          },
          runtimeConfigSummary: summarizeOpenCodeRuntimeConfigForDebug(runtimeConfigOptions),
        },
        'Prepared OpenCode runtime config',
      );
    } else if (provider === 'opencode' && openCodeL0InstructionPaths) {
      // F203 Phase I safety net (砚砚 P1 three-path guard): when the full runtime
      // config condition is NOT met (e.g. subscription mode, no resolvedAccount,
      // known legacy model without MCP), we STILL need instructions in a config
      // so the cat doesn't lose its L0 identity.
      //
      // P1-1 fix: use instructions-only config (no provider block) + signal
      // OC_INSTRUCTIONS_ONLY_ENV so buildEnv does NOT clear native auth.
      openCodeRuntimeConfigPath = writeOpenCodeInstructionsOnlyConfig(
        projectRoot,
        catId as string,
        invocationId,
        openCodeL0InstructionPaths,
      );
      callbackEnv.OPENCODE_CONFIG = openCodeRuntimeConfigPath;
      callbackEnv[OC_INSTRUCTIONS_ONLY_ENV] = '1';
      log.info(
        { catId, invocationId, openCodeConfigPath: openCodeRuntimeConfigPath },
        'F203 Phase I: wrote instructions-only OpenCode config (fallback path, auth preserved)',
      );
    }

    // F-BLOAT: Only inject staticIdentity (systemPrompt) on new sessions for cats
    // that support persistent sessions (sessionChain=true).
    // Cats with sessionChain=false always need it — each turn is effectively new.
    // Note: As of F053, all cats (including Gemini) have sessionChain=true.
    // Exception: compression detected → force re-inject (see _needsReinjection)
    //
    // Injection method: prepend to prompt string (universal, all CLIs).
    // --append-system-prompt proved unreliable (cats didn't receive content).
    // Codex/Gemini AgentServices also prepend if options.systemPrompt is set,
    // so we intentionally do NOT pass systemPrompt in options to avoid double injection.
    const isResume = !!sessionId;
    const canSkipOnResume = isSessionChainEnabled(catId);
    const compressionKey = `${userId}:${catId as string}:${threadId}`;
    const forceReinjection = _needsReinjection.delete(compressionKey);
    const registryRevision = catRegistry.getRevision();
    const identityKey = sessionIdentityKey(userId, catId, threadId);
    const lastStaticIdentityRevision = _staticIdentityRegistryRevision.get(identityKey);
    const registryChangedSinceStaticIdentity =
      canSkipOnResume &&
      isResume &&
      lastStaticIdentityRevision !== undefined &&
      lastStaticIdentityRevision !== registryRevision;
    const injectSystemPrompt = !canSkipOnResume || !isResume || forceReinjection || registryChangedSinceStaticIdentity;
    if (canSkipOnResume) {
      if (injectSystemPrompt) {
        _staticIdentityRegistryRevision.set(identityKey, registryRevision);
      } else if (isResume && lastStaticIdentityRevision === undefined) {
        _staticIdentityRegistryRevision.set(identityKey, registryRevision);
      }
    }

    // Prepend staticIdentity to prompt when injection is needed
    // F070-P2: missionPrefix (dispatch context) is prepended for external projects
    const promptWithMission = missionPrefix ? `${missionPrefix}\n\n${prompt}` : prompt;

    let effectivePrompt =
      injectSystemPrompt && params.systemPrompt
        ? `${params.systemPrompt}\n\n---\n\n${promptWithMission}`
        : `${promptWithMission}`;

    // F225 软层: deliver a pending context-management hint into the cat's actual
    // prompt (a system_info output can't reach cat cognition — see
    // context-management-hint). Queued on the prior warn turn; independent of
    // injectSystemPrompt so it lands even on resumes that skip identity re-injection.
    const contextHintPrefix = takeContextHintPrefix(compressionKey);
    if (contextHintPrefix) {
      effectivePrompt = `${contextHintPrefix}\n\n---\n\n${effectivePrompt}`;
    }

    // L0-budget-defense PR-B-impl (ADR-038 件套 ④): staging layer prepend.
    // Wired here (next to F225 contextHintPrefix) and NOT folded into
    // staticIdentity — Cloud R2 P1 #2237 L1099: folding into staticIdentity
    // would let resumed session-chain turns drop staging because the
    // staticIdentity injection is skipped on canSkipOnResume + isResume
    // turns. ADR-038 contract is "每轮注入生效" → must mirror F225 pattern
    // (independent of injectSystemPrompt). Staging content goes to runtime
    // prompt path, NOT compiled native L0 (砚砚 PR #2221 R1 P2 boundary).
    const stagingPrepend = buildStagingPrepend(catId);
    if (stagingPrepend) {
      effectivePrompt = `${stagingPrepend}\n\n---\n\n${effectivePrompt}`;
    }

    effectivePrompt = appendTranscriptPathHints(effectivePrompt, TRANSCRIPT_DIR, threadId);

    capturePromptIfEnabled({
      catId: catId as string,
      invocationId,
      threadId,
      userId,
      model: resolvedAccount?.models?.[0] ?? 'unknown',
      systemPrompt: params.systemPrompt ?? '',
      missionPrefix: missionPrefix ?? undefined,
      userPrompt: prompt,
      effectivePrompt,
      injectionDecision: { isResume, canSkipOnResume, forceReinjection, injected: injectSystemPrompt },
      // AC-G10 (Phase G native L0 closure / KD-44): if this provider injects
      // L0 via a native system-role channel (Claude `--system-prompt-file` /
      // Codex `-c developer_instructions=`), the bridge will best-effort
      // fetch the compiled L0 and stamp it onto `nativeSystemPrompt`. Hot
      // path stays non-blocking — the bridge handles fetch async + fail-safe
      // (see comment block in prompt-capture-bridge.ts).
      nativeL0Provider: service.injectsL0Natively?.() ?? false,
    });

    // F089 Phase 2+3: Create tmux spawn override for agent-in-pane execution
    let spawnCliOverride: AgentServiceOptions['spawnCliOverride'];
    if (deps.tmuxGateway && workingDirectory) {
      const { resolveWorktreeIdByPath } = await import('../../../../workspace/workspace-security.js');
      const { createTmuxSpawnOverride } = await import('../../../../terminal/tmux-agent-spawner.js');
      try {
        const worktreeId = await resolveWorktreeIdByPath(workingDirectory);
        spawnCliOverride = createTmuxSpawnOverride(
          worktreeId,
          invocationId,
          userId,
          deps.tmuxGateway,
          deps.agentPaneRegistry,
        );
      } catch {
        log.warn({ workingDirectory }, 'resolveWorktreeIdByPath failed — skipping tmux pane');
      }
    }

    const baseOptions: AgentServiceOptions = {
      callbackEnv,
      ...(accountEnv ? { accountEnv } : {}),
      auditContext: {
        invocationId,
        threadId,
        userId,
        catId,
      },
      ...(workingDirectory ? { workingDirectory } : {}),
      ...(params.contentBlocks ? { contentBlocks: params.contentBlocks } : {}),
      ...(params.uploadDir ? { uploadDir: params.uploadDir } : {}),
      ...(signal ? { signal } : {}),
      ...(spawnCliOverride ? { spawnCliOverride } : {}),
      invocationId,
      ...(sessionId ? { cliSessionId: sessionId } : {}),
      // F118 Phase B: Enable liveness probe for all CLI providers.
      // #774: stallAutoKill clears truly stuck idle-silent CLIs before F216's 10m stale-processing guard.
      // #854: Windows cannot sample CPU; suppress suspected_stall there so CLI_TIMEOUT_MS stays binding.
      livenessProbe: { stallAutoKill: true, stallWarningMs: CAT_INVOCATION_STALL_AUTO_KILL_MS },
      ...(catConfig?.cliConfigArgs?.length ? { cliConfigArgs: catConfig.cliConfigArgs } : {}),
      parentSpan: invocationSpan,
    };

    let lastErrorMessage: string | undefined;
    const userVisibleOutputSessionIds = new Set<string>();
    const userVisibleOutputCountedSessionIds = new Set<string>();

    // clowder#915 R4 cloud P1 #3 (defer seal): when a mid-stream agent_loop
    // crosses the seal threshold (opencode step_finish ≥ 0.85 fillRatio),
    // we capture the seal intent here instead of firing requestSeal inline.
    // The actual sealer.requestSeal + sessionManager.delete + finalize is
    // executed at the `done` event boundary, so post-seal text/tool events
    // in the SAME opencode invocation (tool-loop tail) still find an active
    // SessionRecord via getActive() and write to transcript normally.
    // Cleared on done (after deferred execution) or any inline seal that
    // already fired (the active record is gone so no second seal makes sense).
    let pendingMidStreamSeal: {
      sessionId: string;
      reason: SealReason;
      healthSnapshot: ContextHealth;
      activeRecord: SessionRecord;
    } | null = null;

    const recordActiveSessionUserVisibleOutput = async (): Promise<void> => {
      if (!deps.sessionChainStore || !sessionChainActive) return;
      try {
        // F198 Bug #3: bg looks up its record by the stable chainKey, not
        // getActive (a sealed/rotated bg record must still be found).
        const activeRec =
          isBgCarrier && bgChainKey
            ? await deps.sessionChainStore.getByChainKey(bgChainKey)
            : await deps.sessionChainStore.getActive(catId, threadId);
        if (!activeRec) return;
        userVisibleOutputSessionIds.add(activeRec.id);
        if ((activeRec.messageCount ?? 0) !== 0) return;
        await deps.sessionChainStore.update(activeRec.id, {
          messageCount: 1,
          updatedAt: Date.now(),
        });
        userVisibleOutputCountedSessionIds.add(activeRec.id);
        sessionRounds.record(1, { [AGENT_ID]: catId });
      } catch {
        /* best-effort: messageCount miss won't break invocation */
      }
    };

    const processMessage = async (msg: AgentMessage): Promise<AgentMessage[]> => {
      const outputs: AgentMessage[] = [];

      // clowder#915 (cloud P1): F8/F24 usage + context_health block extracted so
      // it can run from BOTH the `done` branch (existing behavior) AND the
      // `agent_loop` branch (NEW — opencode's step_finish event carries
      // mid-stream token usage via agent_loop). Before this extraction, the
      // agent_loop's early-return at L2322 silently dropped usage → no
      // context_health → no seal → no handoff → opencode CLI hung at context
      // limit. Closes over processMessage's lexical scope (catId, provider,
      // sessionChainActive, deps, outputs, etc.). Parameter `msg` shadows the
      // outer param so all the existing `msg.metadata.usage.*` refs resolve
      // correctly to whatever message we're processing.
      //
      // clowder#915 R4 cloud P1 #3 (defer seal): callers from the agent_loop
      // branch pass `deferSealForMidStream: true` so the seal case CAPTURES
      // intent into `pendingMidStreamSeal` instead of firing `requestSeal`
      // immediately. The actual seal is executed at the `done` boundary, so
      // post-seal text/tool events from the same opencode tool loop still
      // find an active session via getActive() and write to transcript.
      const processUsageAndContextHealth = async (
        msg: AgentMessage,
        options: { deferSealForMidStream?: boolean } = {},
      ): Promise<void> => {
        if (!msg.metadata?.usage) return;
        // F152: Record OTel token usage + LLM call duration
        const modelBucket = normalizeModel(msg.metadata.model ?? '');
        const providerSystem = provider ?? 'unknown';
        const tokenAttrs = {
          [AGENT_ID]: catId,
          [GENAI_SYSTEM]: providerSystem,
          [GENAI_MODEL]: modelBucket,
          [OPERATION_NAME]: 'invoke',
        };
        if (msg.metadata.usage.inputTokens) {
          tokenUsage.add(msg.metadata.usage.inputTokens, { ...tokenAttrs, [STATUS]: 'input' });
        }
        if (msg.metadata.usage.outputTokens) {
          tokenUsage.add(msg.metadata.usage.outputTokens, { ...tokenAttrs, [STATUS]: 'output' });
        }
        if (msg.metadata.usage.durationApiMs) {
          llmCallDuration.record(msg.metadata.usage.durationApiMs / 1000, tokenAttrs);
        }

        // F153 Phase B: Retrospective LLM call span (created after-the-fact from done event)
        // Only create when durationApiMs is available — providers without timing data
        // (Codex, Gemini, Kimi) would produce misleading 0-duration spans.
        if (invocationSpan && msg.metadata.usage.durationApiMs) {
          recordLlmCallSpan(
            invocationSpan,
            catId,
            providerSystem,
            modelBucket,
            {
              durationApiMs: msg.metadata.usage.durationApiMs,
              inputTokens: msg.metadata.usage.inputTokens,
              outputTokens: msg.metadata.usage.outputTokens,
              cacheReadTokens: msg.metadata.usage.cacheReadTokens,
            },
            invocationId,
          );
        }

        // F230: include model + provider so all carrier paths (PTY, bg, -p) can
        // populate bubble footer metadata from invocation_usage.
        // PTY carrier text events carry no metadata (transcriptEntriesToAgentMessages);
        // this is their only metadata source. For -p/bg the frontend handler is
        // first-write-wins → idempotent (text event writes metadata first, this is no-op).
        outputs.push({
          type: 'system_info' as const,
          catId,
          content: JSON.stringify({
            type: 'invocation_usage',
            catId,
            usage: msg.metadata.usage,
            model: msg.metadata.model,
            provider: msg.metadata.provider,
          }),
          timestamp: Date.now(),
        });

        // F24: Compute and emit context health (only when session chain is enabled)
        if (sessionChainActive) {
          // #679: Gemini CLI token stats are cumulative across all turns — not usable
          // for context fill. Skip entire context_health block (raw usage still in
          // invocation_usage above). Guard auto-disables when lastTurnInputTokens exists.
          const isCumulativeOnly =
            msg.metadata.usage.isCumulativeUsage === true && msg.metadata.usage.lastTurnInputTokens == null;
          // Use lastTurnInputTokens (per-API-call) for accurate context fill,
          // then fallback to aggregated inputTokens, and finally totalTokens
          // for providers (Gemini CLI) that only expose a total count.
          // clowder#915 R5 cloud P2: 3-tier window resolution.
          // 1) Explicit `usage.contextWindowSize` (CLI-reported — Claude's exact value)
          // 2) Fallback table by bare model name (handles prefix-strip for
          //    account-routing path's `provider/model` form per R2 P1 #2)
          // 3) opencode-only last-resort default for unknown/custom-provider
          //    models (GLM-5.1, openrouter customs — the breed clowder#915
          //    actually targets). Crucially this is LAST so known opencode
          //    models like the default claude-opus-4-6 get their precise 200k
          //    from the table, NOT the 128k conservative default.
          const windowSize =
            msg.metadata.usage.contextWindowSize ??
            getContextWindowFallback(msg.metadata.model ?? '') ??
            (msg.metadata.provider === 'opencode' ? OPENCODE_DEFAULT_CONTEXT_WINDOW : undefined);
          const usedFrom =
            msg.metadata.usage.lastTurnInputTokens != null
              ? 'last_turn'
              : msg.metadata.usage.inputTokens != null
                ? 'input'
                : msg.metadata.usage.totalTokens != null
                  ? 'total'
                  : undefined;
          const usedTokens =
            usedFrom === 'last_turn'
              ? msg.metadata.usage.lastTurnInputTokens!
              : usedFrom === 'input'
                ? msg.metadata.usage.inputTokens!
                : usedFrom === 'total'
                  ? msg.metadata.usage.totalTokens!
                  : 0;
          if (windowSize && usedTokens > 0 && isCumulativeOnly) {
            log.warn(
              {
                catId,
                threadId,
                invocationId,
                cumulativeUsedTokens: usedTokens,
                windowSize,
                usedFrom,
              },
              'Gemini cumulative-only usage observed; skipping context_health and auto-seal',
            );
            geminiContextFallback.add(1, { [AGENT_ID]: catId, [TRIGGER]: 'no_per_turn_signal' });
          }
          if (windowSize && usedTokens > 0 && !isCumulativeOnly) {
            const source: ContextHealth['source'] =
              msg.metadata.usage.contextWindowSize != null && usedFrom !== 'total' ? 'exact' : 'approx';
            const health: ContextHealth = {
              usedTokens,
              windowTokens: windowSize,
              fillRatio: Math.min(usedTokens / windowSize, 1.0),
              source,
              usedFrom,
              measuredAt: Date.now(),
            };
            // Update SessionRecord (best-effort): persist health + usage snapshot
            if (deps.sessionChainStore) {
              try {
                const activeRecord = await deps.sessionChainStore.getActive(catId, threadId);
                if (activeRecord) {
                  const u = msg.metadata?.usage!;
                  await deps.sessionChainStore.update(activeRecord.id, {
                    contextHealth: health,
                    lastUsage: {
                      ...(u.inputTokens != null ? { inputTokens: u.inputTokens } : {}),
                      ...(u.outputTokens != null ? { outputTokens: u.outputTokens } : {}),
                      ...(u.cacheReadTokens != null ? { cacheReadTokens: u.cacheReadTokens } : {}),
                      ...(u.costUsd != null ? { costUsd: u.costUsd } : {}),
                    },
                    updatedAt: Date.now(),
                  });
                }
              } catch {
                /* best-effort */
              }
            }
            // F-BLOAT: Detect context compression for re-injection on next turn.
            // When usedTokens drops >60% from previous known value, the CLI
            // auto-compacted its context. Flag for systemPrompt re-injection.
            const cKey = `${userId}:${catId as string}:${threadId}`;
            const prevFill = _prevContextFill.get(cKey);
            _prevContextFill.set(cKey, usedTokens);
            if (prevFill && usedTokens < prevFill * 0.4) {
              _needsReinjection.add(cKey);
            }
            outputs.push({
              type: 'system_info' as const,
              catId,
              content: JSON.stringify({ type: 'context_health', catId, health }),
              timestamp: Date.now(),
            });

            // F33: Strategy-driven seal decision (replaces F24 Phase B shouldSeal)
            if (deps.sessionSealer && deps.sessionChainStore) {
              try {
                // F062-fix:
                // 1) api_key + approx health can be noisy on third-party gateways
                // 2) api_key + compress strategy should not be force-sealed here
                // Keep context_health observability in both cases.
                const provider = catRegistry.tryGet(catId as string)?.config.clientId;
                const profileMode = callbackEnv[ANTHROPIC_PROFILE_MODE_KEY];
                const strategy = getSessionStrategy(catId as string);
                const isAnthropicApiKey = provider === 'anthropic' && profileMode === ANTHROPIC_PROFILE_MODE_API_KEY;
                const skipAutoSealForApproxApiKey = isAnthropicApiKey && health.source === 'approx';
                const skipAutoSealForApiKeyCompress = isAnthropicApiKey && strategy.strategy === 'compress';
                if (!skipAutoSealForApproxApiKey && !skipAutoSealForApiKeyCompress) {
                  const activeRecord = await deps.sessionChainStore.getActive(catId, threadId);
                  const action = shouldTakeAction(
                    health.fillRatio,
                    health.windowTokens,
                    health.usedTokens,
                    activeRecord?.compressionCount ?? 0,
                    strategy,
                  );

                  switch (action.type) {
                    case 'none':
                      break;
                    case 'warn': {
                      // F225 软层: queue a cat-facing hint for the NEXT prompt. A
                      // system_info output would never reach the cat (routing feeds only
                      // `text` into previousResponses; ContextAssembler drops
                      // userId='system') — so we ride the prompt-injection channel
                      // (consumed at effectivePrompt assembly, ~line 1538). Nudges the cat
                      // to run the context-self-management 3-axis self-check — NOT "handoff
                      // now" (handoff-vs-compress is the cat's judgment). cKey matches the
                      // compressionKey used there: `${userId}:${catId}:${threadId}`.
                      queueContextHint(
                        cKey,
                        buildContextManagementHint({
                          source: health.source,
                          compressionCount: activeRecord?.compressionCount ?? 0,
                        }),
                      );
                      break;
                    }
                    case 'seal':
                    case 'seal_after_compress': {
                      if (activeRecord) {
                        // clowder#915 R4 cloud P1 #3: when called from agent_loop
                        // (deferSealForMidStream=true), CAPTURE the seal intent
                        // and let the `done` branch execute it. Firing inline
                        // here would clear the active session pointer and break
                        // transcript writes for the rest of the opencode
                        // tool-loop's text/tool events.
                        if (options.deferSealForMidStream) {
                          pendingMidStreamSeal = {
                            sessionId: activeRecord.id,
                            reason: action.reason,
                            healthSnapshot: health,
                            activeRecord,
                          };
                          break;
                        }
                        const sealResult = await deps.sessionSealer.requestSeal({
                          sessionId: activeRecord.id,
                          reason: action.reason,
                        });
                        if (sealResult.accepted) {
                          // If a done-path seal just fired inline, any pending
                          // mid-stream intent is now obsolete (active record is
                          // gone). Clear so the deferred-execution block below
                          // does not double-seal.
                          pendingMidStreamSeal = null;
                          sessionManager.delete(userId, catId, threadId).catch(() => {});
                          const sealTimestamp = Date.now();
                          const continuityCapsule = params.continuityCapsule
                            ? completeCapsuleForSeal(params.continuityCapsule, {
                                invocationId,
                                createdAt: sealTimestamp,
                                seal: {
                                  sessionId: activeRecord.id,
                                  sessionSeq: activeRecord.seq + 1,
                                  reason: action.reason,
                                  healthSnapshot: health,
                                },
                              })
                            : undefined;
                          const sealInfoMessage = {
                            type: 'system_info' as const,
                            catId,
                            content: JSON.stringify({
                              type: 'session_seal_requested',
                              catId,
                              sessionId: activeRecord.id,
                              sessionSeq: activeRecord.seq + 1,
                              reason: action.reason,
                              healthSnapshot: health,
                              ...(continuityCapsule
                                ? {
                                    continuityCapsule,
                                    continuityDiagnostics: {
                                      source: 'route_state',
                                      boundary: continuityCapsule.continuationReason,
                                      generated: true,
                                      persistedVia: 'session_seal_requested',
                                      threadId,
                                      catId,
                                      invocationId,
                                      sessionId: activeRecord.id,
                                    },
                                  }
                                : {}),
                            }),
                            timestamp: sealTimestamp,
                          };
                          outputs.push(sealInfoMessage);
                          if (deps.transcriptWriter) {
                            const sessInfo: TranscriptSessionInfo = {
                              sessionId: activeRecord.id,
                              threadId,
                              catId: activeRecord.catId,
                              cliSessionId: activeRecord.cliSessionId,
                              seq: activeRecord.seq,
                            };
                            deps.transcriptWriter.appendEvent(
                              sessInfo,
                              sealInfoMessage as unknown as Record<string, unknown>,
                              invocationId,
                            );
                          }
                          deps.sessionSealer.finalize({ sessionId: activeRecord.id }).catch(() => {});
                        }
                      }
                      break;
                    }
                    case 'allow_compress':
                      // Don't seal — let CLI compress. Log for observability.
                      outputs.push({
                        type: 'system_info' as const,
                        catId,
                        content: JSON.stringify({
                          type: 'strategy_allow_compress',
                          catId,
                          strategy: strategy.strategy,
                          compressionCount: activeRecord?.compressionCount ?? 0,
                          healthSnapshot: health,
                        }),
                        timestamp: Date.now(),
                      });
                      break;
                  }
                }
              } catch {
                /* best-effort: strategy failure doesn't break invocation */
              }
            }
          }
        }
      };

      if (msg.type === 'error') {
        hadStreamError = true;
        lastErrorMessage = msg.error;
      }

      if (msg.type === 'session_init' && msg.sessionId) {
        log.info(
          { cliSessionId: msg.sessionId, threadId, catId, userId, invocationId },
          'Session init: binding session',
        );
        try {
          await sessionManager.store(userId, catId, threadId, msg.sessionId);
        } catch {
          // Redis write failure — session won't persist, but chain continues
        }

        // F198 Phase C P1-1: register bg carrier daemon session for Hub observability.
        // Only fires when the provider is claude-bg; msg.sessionId is the daemon shortId.
        if (deps.agentPaneRegistry && msg.metadata?.provider === 'claude-bg') {
          deps.agentPaneRegistry.registerBgCarrier({
            invocationId,
            catId,
            daemonShortId: msg.sessionId,
            threadId,
          });
        }

        // F24 + F198 Bug #3: ensure a SessionRecord exists for this session.
        if (isBgCarrier && bgChainKey && deps.sessionChainStore && sessionChainActive) {
          // bg: look up the conversation by its stable chainKey. ACTIVE record →
          // just update cliSessionId to the current daemon shortId (NO seal+create
          // — that cascade is the multi-turn amnesia root cause). Missing (first
          // round) OR externally sealed (cloud review P1: manual/threshold/reaper)
          // → create a fresh record carrying the chainKey; the index re-points to
          // it and the sealed record is NOT revived. (done bookkeeping still uses
          // getByChainKey without a status filter for write tolerance.)
          try {
            const bgRec = await deps.sessionChainStore.getByChainKey(bgChainKey);
            if (bgRec && bgRec.status === 'active') {
              if (bgRec.cliSessionId !== msg.sessionId) {
                await deps.sessionChainStore.update(bgRec.id, {
                  cliSessionId: msg.sessionId,
                  ...(params.continuityCapsule ? { continuityCapsule: params.continuityCapsule } : {}),
                  updatedAt: Date.now(),
                });
              } else if (params.continuityCapsule) {
                await deps.sessionChainStore.update(bgRec.id, {
                  continuityCapsule: params.continuityCapsule,
                });
              }
            } else {
              const newRec = await deps.sessionChainStore.create({
                cliSessionId: msg.sessionId,
                threadId,
                catId,
                userId,
                chainKey: bgChainKey,
              });
              if (params.continuityCapsule) {
                await deps.sessionChainStore.update(newRec.id, {
                  continuityCapsule: params.continuityCapsule,
                });
              }
            }
          } catch {
            // Best-effort — don't break the invocation chain
          }
        } else if (deps.sessionChainStore && sessionChainActive) {
          try {
            const existing = await deps.sessionChainStore.getActive(catId, threadId);
            if (existing) {
              if (existing.cliSessionId !== msg.sessionId) {
                if (msg.ephemeralSession) {
                  // ACP transport: sessionId is per-invocation (newSession() each time).
                  // This is normal — NOT a "session replaced" event. Just update the tracked ID.
                  await deps.sessionChainStore.update(existing.id, {
                    cliSessionId: msg.sessionId,
                    ...(params.continuityCapsule ? { continuityCapsule: params.continuityCapsule } : {}),
                    updatedAt: Date.now(),
                  });
                } else {
                  // CLI session changed → old context is lost (resume failed / CLI restarted).
                  // Use requestSeal + finalize to ensure transcript/digest are written,
                  // not bare update(status:'sealed') which skips flush.
                  let sealAccepted = false;
                  const sealReason = antigravityReplacementSealReason(msg, existing.cliSessionId);
                  if (deps.sessionSealer) {
                    try {
                      const result = await deps.sessionSealer.requestSeal({
                        sessionId: existing.id,
                        reason: sealReason,
                      });
                      sealAccepted = result.accepted;
                      if (sealAccepted) {
                        const runtimeLifecycle = msg.sessionLifecycle;
                        if (runtimeLifecycle && deps.transcriptWriter) {
                          const sealTimestamp = Date.now();
                          deps.transcriptWriter.appendEvent(
                            {
                              sessionId: existing.id,
                              threadId,
                              catId: existing.catId,
                              cliSessionId: existing.cliSessionId,
                              seq: existing.seq,
                            },
                            {
                              type: 'system_info',
                              catId,
                              content: JSON.stringify({
                                type: 'antigravity_runtime_lifecycle',
                                runtime: runtimeLifecycle.runtime,
                                runtimeSessionId: runtimeLifecycle.runtimeSessionId,
                                previousRuntimeSessionId: runtimeLifecycle.previousRuntimeSessionId,
                                sealReason,
                                drainResult: runtimeLifecycle.drainResult,
                                degraded: runtimeLifecycle.degraded === true,
                                unexpectedRuntimeSessionSwitch:
                                  sealReason === UNEXPECTED_RUNTIME_SESSION_SWITCH_SEAL_REASON,
                                ...(runtimeLifecycle.degradedReason
                                  ? { degradedReason: runtimeLifecycle.degradedReason }
                                  : {}),
                              }),
                              timestamp: sealTimestamp,
                            },
                            invocationId,
                          );
                        }
                        deps.sessionSealer.finalize({ sessionId: existing.id }).catch(() => {});
                      }
                    } catch {
                      /* best-effort seal */
                    }
                  } else {
                    // Fallback: no sealer available — bare update (legacy path)
                    const now = Date.now();
                    await deps.sessionChainStore.update(existing.id, {
                      status: 'sealed',
                      sealReason,
                      sealedAt: now,
                      updatedAt: now,
                    });
                    sealAccepted = true;
                  }
                  // Only create new active record if old one was successfully sealed.
                  // Otherwise we'd have two active records — a dirty state.
                  if (sealAccepted || !deps.sessionSealer) {
                    // F118 D1: Inherit failure count from the replaced session.
                    // create() doesn't accept consecutiveRestoreFailures, so use immediate update().
                    const inheritedFailures = existing.consecutiveRestoreFailures ?? 0;
                    const newRec = await deps.sessionChainStore.create({
                      cliSessionId: msg.sessionId,
                      threadId,
                      catId,
                      userId,
                    });
                    if (inheritedFailures > 0) {
                      await deps.sessionChainStore.update(newRec.id, {
                        consecutiveRestoreFailures: inheritedFailures,
                        ...(params.continuityCapsule ? { continuityCapsule: params.continuityCapsule } : {}),
                      });
                    } else if (params.continuityCapsule) {
                      await deps.sessionChainStore.update(newRec.id, {
                        continuityCapsule: params.continuityCapsule,
                      });
                    }
                  }
                }
              } else if (params.continuityCapsule) {
                await deps.sessionChainStore.update(existing.id, {
                  continuityCapsule: params.continuityCapsule,
                });
              }
            } else {
              // No active session (first invocation or previous was sealed)
              const newRec = await deps.sessionChainStore.create({
                cliSessionId: msg.sessionId,
                threadId,
                catId,
                userId,
              });
              if (params.continuityCapsule) {
                await deps.sessionChainStore.update(newRec.id, {
                  continuityCapsule: params.continuityCapsule,
                });
              }
            }
          } catch {
            // Best-effort — don't break the invocation chain
          }
        }

        if (deps.runtimeSessionStore && deps.sessionChainStore && sessionChainActive) {
          try {
            const activeRec = await deps.sessionChainStore.getActive(catId, threadId);
            if (activeRec) {
              await syncAntigravityRuntimeMetadata({
                runtimeSessionStore: deps.runtimeSessionStore,
                sessionChainStore: deps.sessionChainStore,
                activeRec,
                msg,
                userVisibleOutputSessionIds,
                threadId,
                catId,
                userId,
              });
            }
          } catch (err) {
            log.warn({ threadId, catId, err }, 'Antigravity runtime metadata sync failed');
          }
        }

        // Push session info as system_info for frontend status panel
        // Include sessionSeq if SessionChainStore is available
        let sessionSeq: number | undefined;
        if (deps.sessionChainStore && sessionChainActive) {
          try {
            const activeRec = await deps.sessionChainStore.getActive(catId, threadId);
            sessionSeq = activeRec != null ? activeRec.seq + 1 : undefined;
          } catch {
            /* best-effort */
          }
        }
        outputs.push({
          type: 'system_info' as const,
          catId,
          content: JSON.stringify({
            type: 'invocation_metrics',
            kind: 'session_started',
            sessionId: msg.sessionId,
            invocationId,
            ...(sessionSeq !== undefined ? { sessionSeq } : {}),
          }),
          timestamp: Date.now(),
        });
      }

      if (msg.type === 'done') {
        // === CAT_RESPONDED / CAT_ERROR 审计 (fire-and-forget) ===
        // P1 fix: when error was yielded during stream, emit CAT_ERROR instead of CAT_RESPONDED
        const durationMs = Date.now() - startTime;
        const auditType = hadStreamError ? AuditEventTypes.CAT_ERROR : AuditEventTypes.CAT_RESPONDED;
        auditLog
          .append({
            type: auditType,
            threadId,
            data: {
              catId,
              userId,
              invocationId,
              durationMs,
              ...(hadStreamError ? { error: lastErrorMessage ?? 'unknown stream error' } : {}),
              isFinal: isLastCat,
              metadata: msg.metadata,
            },
          })
          .catch((err) => {
            log.warn({ threadId, invocationId, err }, `${auditType} audit write failed`);
          });

        // Increment session messageCount (best-effort).
        // This counter is critical for unseal safety: empty sessions (0 messages)
        // can be displaced, but sessions with user-visible output must not be
        // silently sealed or folded away before a final done event arrives.
        if (isBgCarrier && bgChainKey && deps.sessionChainStore && sessionChainActive) {
          // F198 Bug #3: bg updates its chainKey record — messageCount (unless
          // already counted this turn via recordActiveSessionUserVisibleOutput)
          // + latestResumeSessionId (the daemon's new fork UUID from done
          // metadata = the NEXT round's `--resume` target).
          try {
            const bgRec = await deps.sessionChainStore.getByChainKey(bgChainKey);
            if (bgRec) {
              const countThisTurn = !userVisibleOutputCountedSessionIds.has(bgRec.id);
              const newCount = (bgRec.messageCount ?? 0) + 1;
              const resumeSessionId = msg.metadata?.resumeSessionId;
              const updateResume =
                typeof resumeSessionId === 'string' && resumeSessionId !== bgRec.latestResumeSessionId;
              await deps.sessionChainStore.update(bgRec.id, {
                updatedAt: Date.now(),
                ...(countThisTurn ? { messageCount: newCount } : {}),
                ...(updateResume ? { latestResumeSessionId: resumeSessionId } : {}),
              });
              if (countThisTurn) {
                sessionRounds.record(newCount, { [AGENT_ID]: catId });
              }
            }
          } catch {
            /* best-effort: messageCount miss won't break invocation */
          }
        } else if (deps.sessionChainStore && sessionChainActive) {
          try {
            const activeRec = await deps.sessionChainStore.getActive(catId, threadId);
            if (activeRec) {
              if (!userVisibleOutputCountedSessionIds.has(activeRec.id)) {
                const newCount = (activeRec.messageCount ?? 0) + 1;
                await deps.sessionChainStore.update(activeRec.id, {
                  messageCount: newCount,
                  updatedAt: Date.now(),
                });
                sessionRounds.record(newCount, { [AGENT_ID]: catId });
              }
            }
          } catch {
            /* best-effort: messageCount miss won't break invocation */
          }
        }

        // Push completion metrics for frontend status panel
        outputs.push({
          type: 'system_info' as const,
          catId,
          content: JSON.stringify({
            type: 'invocation_metrics',
            kind: 'invocation_complete',
            invocationId,
            durationMs,
            sessionId: msg.metadata?.sessionId,
          }),
          timestamp: Date.now(),
        });

        // F070 Phase 3a: Capture execution digest for external project dispatch (best-effort)
        if (capturedMissionPack && workingDirectory && deps.executionDigestStore) {
          try {
            const { captureExecutionDigest } = await import(
              '../../../../../config/governance/execution-digest-capture.js'
            );
            const digestInput = captureExecutionDigest(
              capturedMissionPack,
              {
                summary: '', // Populated by HandoffDigestGenerator in future enhancement
                filesChanged: [],
                blocked: false,
                hadError: hadStreamError,
              },
              { projectPath: workingDirectory, threadId, catId: catId as string, userId },
            );
            deps.executionDigestStore.create(digestInput);
          } catch {
            /* best-effort: digest capture failure doesn't break invocation */
          }
        }

        // F8/F24 usage + context_health (extracted to helper for clowder#915
        // — see processUsageAndContextHealth declaration at top of processMessage).
        await processUsageAndContextHealth(msg);

        // clowder#915 R4 cloud P1 #3 (defer seal execution): if an earlier
        // agent_loop captured a pending seal intent and the done-branch
        // helper above didn't already fire its own seal (which would have
        // cleared pendingMidStreamSeal), execute the deferred seal NOW at
        // this clean boundary. Built from the snapshot captured at agent_loop
        // time, so health/reason/continuity reflect the moment the threshold
        // was actually crossed (not whatever done's metadata.usage happens
        // to carry, which is often empty for opencode).
        if (pendingMidStreamSeal && deps.sessionSealer && deps.sessionChainStore) {
          const pending = pendingMidStreamSeal;
          pendingMidStreamSeal = null;
          try {
            const sealResult = await deps.sessionSealer.requestSeal({
              sessionId: pending.sessionId,
              reason: pending.reason,
            });
            if (sealResult.accepted) {
              sessionManager.delete(userId, catId, threadId).catch(() => {});
              const sealTimestamp = Date.now();
              const continuityCapsule = params.continuityCapsule
                ? completeCapsuleForSeal(params.continuityCapsule, {
                    invocationId,
                    createdAt: sealTimestamp,
                    seal: {
                      sessionId: pending.sessionId,
                      sessionSeq: pending.activeRecord.seq + 1,
                      reason: pending.reason,
                      healthSnapshot: pending.healthSnapshot,
                    },
                  })
                : undefined;
              const sealInfoMessage = {
                type: 'system_info' as const,
                catId,
                content: JSON.stringify({
                  type: 'session_seal_requested',
                  catId,
                  sessionId: pending.sessionId,
                  sessionSeq: pending.activeRecord.seq + 1,
                  reason: pending.reason,
                  healthSnapshot: pending.healthSnapshot,
                  // Mark as deferred so downstream observers can distinguish
                  // mid-stream-captured seals from synchronous done-time seals.
                  deferredFrom: 'mid_stream_agent_loop',
                  ...(continuityCapsule
                    ? {
                        continuityCapsule,
                        continuityDiagnostics: {
                          source: 'route_state',
                          boundary: continuityCapsule.continuationReason,
                          generated: true,
                          persistedVia: 'session_seal_requested',
                          threadId,
                          catId,
                          invocationId,
                          sessionId: pending.sessionId,
                        },
                      }
                    : {}),
                }),
                timestamp: sealTimestamp,
              };
              outputs.push(sealInfoMessage);
              if (deps.transcriptWriter) {
                const sessInfo: TranscriptSessionInfo = {
                  sessionId: pending.activeRecord.id,
                  threadId,
                  catId: pending.activeRecord.catId,
                  cliSessionId: pending.activeRecord.cliSessionId,
                  seq: pending.activeRecord.seq,
                };
                deps.transcriptWriter.appendEvent(
                  sessInfo,
                  sealInfoMessage as unknown as Record<string, unknown>,
                  invocationId,
                );
              }
              deps.sessionSealer.finalize({ sessionId: pending.sessionId }).catch(() => {});
            }
          } catch {
            /* best-effort: deferred seal failure doesn't break invocation */
          }
        }

        outputs.push({ ...msg, isFinal: isLastCat });
      } else {
        // F153 Phase I: agent_loop is telemetry-only — record marker, never push to outputs
        // (no user-visible signal, no transcript write, no downstream forwarding).
        // processMessage is an arrow function (not a loop), so `return outputs` (empty here)
        // is the correct way to skip the remaining branches and transcript writer below.
        if (msg.type === 'agent_loop') {
          if (invocationSpan) recordAgentLoop(invocationSpan);
          // clowder#915: opencode emits step_finish (mid-stream LLM-call boundary)
          // as agent_loop carrying token usage. Route through F8/F24 so
          // context_health computes + seal can fire BEFORE the CLI hits its context
          // window. For agent_loop messages without usage (other producers under
          // F153 Phase I semantics), the helper returns early — no behavior change.
          //
          // clowder#915 R4 cloud P1 #3: deferSealForMidStream=true so the helper
          // CAPTURES seal intent into pendingMidStreamSeal instead of firing
          // requestSeal inline. The actual seal executes at the `done` boundary
          // below — preserving transcript writes for the rest of the opencode
          // tool-loop's text/tool events.
          await processUsageAndContextHealth(msg, { deferSealForMidStream: true });
          return outputs;
        }
        // Main-merge: record user-visible session output (independent of toolTracing — uses raw msg).
        if (isUserVisibleSessionOutput(msg)) {
          await recordActiveSessionUserVisibleOutput();
        }

        // F153 Phase J AC-J2/J3 + J-B AC-J7: real-duration MCP tool spans when provider
        // injects toolUseId, legacy zero-duration fallback otherwise (provider not yet
        // wired per KD-41). For Slice J-B: enrich the AgentMessage with `toolTracing` so
        // downstream `toStoredToolEvent` carries the tool span pointer into persistence
        // (enabling AC-J8 hydrate-side real-duration restore). Push happens after enrichment
        // (see line below) so outputs carry the enriched form, not the raw msg.
        let enrichedMsg = msg;
        if (msg.type === 'tool_use' && msg.toolName && invocationSpan) {
          if (msg.toolUseId) {
            const span = toolSpanTracker.start(msg.toolName, msg.toolUseId, msg.toolInput as Record<string, unknown>);
            if (span) {
              const sc = span.spanContext();
              enrichedMsg = {
                ...msg,
                toolTracing: {
                  traceId: sc.traceId,
                  spanId: sc.spanId,
                  parentSpanId: invocationSpan.spanContext().spanId,
                },
              };
            }
          } else {
            recordToolUseSpan(invocationSpan, catId, msg.toolName, msg.toolInput as Record<string, unknown>);
          }
        }
        // F153 Phase J AC-J2 + J-B AC-J7: pair tool_result with matching tool_use span,
        // stamp `toolTracing` BEFORE closing the span (getContext peeks without removing),
        // then close with status.
        if (msg.type === 'tool_result' && msg.toolUseId) {
          const ctx = toolSpanTracker.getContext(msg.toolUseId);
          if (ctx && invocationSpan) {
            enrichedMsg = {
              ...msg,
              toolTracing: {
                traceId: ctx.traceId,
                spanId: ctx.spanId,
                parentSpanId: invocationSpan.spanContext().spanId,
              },
            };
          }
          toolSpanTracker.end(msg.toolUseId, msg.toolResultStatus ?? 'unknown');
        }

        outputs.push(attachInvocationIdToTaskProgress(enrichedMsg));

        // F26: Detect task management tools and emit task_progress for frontend
        if (msg.type === 'tool_use' && msg.toolName) {
          const progress = extractTaskProgress(msg.toolName, msg.toolInput);
          if (progress) {
            outputs.push({
              type: 'system_info' as const,
              catId,
              content: JSON.stringify({ type: 'task_progress', catId, invocationId, ...progress }),
              timestamp: Date.now(),
            });
          }
        }
      }

      // F24 Phase C: Record event to transcript buffer (best-effort)
      if (deps.transcriptWriter && deps.sessionChainStore && sessionChainActive) {
        try {
          const activeRec = await deps.sessionChainStore.getActive(catId, threadId);
          if (activeRec) {
            const sessInfo: TranscriptSessionInfo = {
              sessionId: activeRec.id,
              threadId,
              catId: activeRec.catId,
              cliSessionId: activeRec.cliSessionId,
              seq: activeRec.seq,
            };
            // Record the raw agent message as a transcript event
            deps.transcriptWriter.appendEvent(sessInfo, msg as unknown as Record<string, unknown>, invocationId);
          }
        } catch {
          /* best-effort */
        }
      }

      return outputs;
    };

    const streamProcessedOutputs = async function* (sourceMsg: AgentMessage | undefined): AsyncIterable<AgentMessage> {
      if (!sourceMsg) return;
      for (const out of await processMessage(sourceMsg)) {
        if (out.type === 'error') {
          hadError = true;
          terminalTaskProgressStatus = 'interrupted';
          terminalInterruptReason = 'error';
        }
        await maybePersistTaskProgress(out);
        if (out.type === 'done' && terminalTaskProgressStatus === null) {
          if (hadError) {
            terminalTaskProgressStatus = 'interrupted';
            terminalInterruptReason = 'error';
          } else if (signal?.aborted) {
            terminalTaskProgressStatus = 'interrupted';
            terminalInterruptReason = 'aborted';
          } else {
            terminalTaskProgressStatus = 'completed';
            terminalInterruptReason = null;
          }
        }
        if (out.type === 'done') {
          await finalizeTaskProgress();
          if (!out.tracing) {
            const sc = invocationSpan.spanContext();
            const parentSid = params.routeSpan?.spanContext().spanId;
            out.tracing = {
              traceId: sc.traceId,
              spanId: sc.spanId,
              ...(parentSid ? { parentSpanId: parentSid } : {}),
            };
          }
        }
        yield out;
      }
    };

    // Self-heal policy (at most one retry total):
    // 1) stale --resume session: "No conversation found with session ID ..."
    // 2) poisoned --resume session: "prompt token count ... exceeds the limit ..."
    // 3) transient CLI bootstrap exit: "CLI 异常退出 (code: 1, signal: none)"
    const initialResumeSessionId = sessionId;
    const shouldTrackGeminiResumeFailures = catId === 'gemini' && Boolean(initialResumeSessionId);
    const resumeFailureCounts: Partial<Record<ResumeFailureKind, number>> = {};
    const maxAttempts = 2;

    // Universal debug log: capture everything needed to diagnose invocation issues.
    // This is provider-agnostic — every cat (Claude, Codex, Gemini, OpenCode, etc.)
    // passes through here before service.invoke() is called.
    {
      const maskEnv = (env: Record<string, string>): Record<string, string> => {
        const masked: Record<string, string> = {};
        for (const k of Object.keys(env)) {
          masked[k] = '***';
        }
        return masked;
      };
      log.debug(
        {
          invocationId,
          catId,
          threadId,
          userId,
          provider: provider ?? 'unknown',
          protocol: effectiveProtocol ?? 'default',
          model: defaultModel ?? 'default',
          accountId: resolvedAccount?.id ?? null,
          accountAuthType: resolvedAccount?.authType ?? null,
          sessionId: sessionId ?? null,
          isResume,
          injectSystemPrompt,
          forceReinjection,
          workingDirectory: workingDirectory ?? null,
          promptLength: effectivePrompt.length,
          systemPromptLength: params.systemPrompt?.length ?? 0,
          callbackEnv: maskEnv(callbackEnv),
          ...(accountEnv ? { accountEnv: maskEnv(accountEnv) } : {}),
        },
        '[invocation] service.invoke() — full context before subprocess launch',
      );
    }

    let allowSessionRetry = Boolean(sessionId);
    let allowTransientRetry = true;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const attemptStartedAt = Date.now();
      const options: AgentServiceOptions = {
        ...(sessionId ? { sessionId } : {}),
        ...baseOptions,
      };
      let suppressedMissingSessionError: AgentMessage | undefined;
      let suppressedPromptLimitError: AgentMessage | undefined;
      let suppressedContextOverflowError: AgentMessage | undefined;
      let suppressedTransientCliError: AgentMessage | undefined;
      let suppressedTimeoutError: AgentMessage | undefined;
      // F215: Suppress malformed tool-call error for seal+fresh-retry (AC-C1/C2).
      // Also suppress the system_info malformed_toolcall_detected signal that precedes the error.
      let suppressedMalformedError: AgentMessage | undefined;
      let shouldRetryWithoutSession = false;
      let shouldRetryOnTransientCliExit = false;
      let attemptHasContentOutput = false;
      // Substantive = real model output (text/tool), excludes system_info/session_init/error/done.
      // Used for timeout-retry: system_info (e.g. timeout_diagnostics) must NOT block retry.
      let attemptHasSubstantiveOutput = false;

      // F089: Use abortableNext instead of `for await` so the invocation timeout
      // can break out even when the service generator is stuck on an unresolvable await.
      const serviceIter = service.invoke(effectivePrompt, options)[Symbol.asyncIterator]();
      for (;;) {
        const iterResult = await abortableNext(serviceIter, signal);
        if (iterResult.done) break;
        const msg = iterResult.value;
        // F149: provider_signal / liveness_signal must NOT reset timeout — prevents "续命"
        // F198 Phase C P2-1: status (daemon detail progress) also must NOT reset timeout —
        // a daemon sending frequent status updates must not evade the 30-min kill deadline.
        if (msg.type !== 'provider_signal' && msg.type !== 'liveness_signal' && msg.type !== 'status')
          resetInvocationTimeout();
        if (shouldTrackGeminiResumeFailures && options.sessionId && msg.type === 'error') {
          const failureKind = classifyResumeFailure(msg.error);
          if (failureKind) {
            resumeFailureCounts[failureKind] = (resumeFailureCounts[failureKind] ?? 0) + 1;
          }
        }

        if (allowSessionRetry && msg.type === 'error' && isMissingClaudeSessionError(msg.error)) {
          suppressedMissingSessionError = msg;
          continue;
        }
        if (
          allowSessionRetry &&
          !attemptHasContentOutput &&
          msg.type === 'error' &&
          isPromptTokenLimitExceededError(msg.error)
        ) {
          suppressedPromptLimitError = msg;
          continue;
        }
        if (
          allowSessionRetry &&
          !attemptHasContentOutput &&
          msg.type === 'error' &&
          isContextWindowOverflowError(msg.error)
        ) {
          suppressedContextOverflowError = msg;
          continue;
        }
        if (
          allowTransientRetry &&
          !attemptHasContentOutput &&
          msg.type === 'error' &&
          (isTransientCliExitCode1(msg.error) || isTransientAcpPromptFailure(msg.error))
        ) {
          suppressedTransientCliError = msg;
          continue;
        }
        // #774 self-heal: CLI timeout during session resume with no substantive output
        // → likely stale/unreachable session. Suppress and retry without session.
        // Uses attemptHasSubstantiveOutput (not attemptHasContentOutput) because
        // timeout_diagnostics (system_info) must NOT block the retry path.
        if (
          allowSessionRetry &&
          options.sessionId &&
          !attemptHasSubstantiveOutput &&
          msg.type === 'error' &&
          isCliTimeoutError(msg.error)
        ) {
          suppressedTimeoutError = msg;
          continue;
        }
        // F215 AC-C1/C2: Suppress malformed tool-call error + preceding system_info signal
        // → seal session + fresh-context retry (sessionId=undefined).
        // Applies on all attempts (even without session) so a retried invocation that still
        // produces malformed output also enters the fallback chain.
        //
        // BLOCKING 2 fix: malformed_toolcall_detected is emitted BEFORE the error, so we
        // must suppress it unconditionally (not gated on suppressedMalformedError being set).
        if (
          msg.type === 'system_info' &&
          (() => {
            try {
              return JSON.parse(msg.content ?? '{}').type === 'malformed_toolcall_detected';
            } catch {
              return false;
            }
          })()
        ) {
          // Internal detection signal — always suppress; never reaches user.
          continue;
        }
        // P1 7th fix: only suppress malformed error (and retry) when NO content was emitted yet.
        // Other self-heal paths (prompt limit, context overflow) all guard on !attemptHasContentOutput.
        // Without this guard, a multi-step run that used a tool then ended with a malformed turn
        // would re-run the original prompt from scratch — duplicating tool actions.
        if (msg.type === 'error' && isMalformedToolCallError(msg.error) && !attemptHasContentOutput) {
          suppressedMalformedError = msg;
          continue;
        }
        // F215 AC-B6 UX fix: when content was already emitted, the malformed error must NOT reach
        // the user with "系统已触发恢复流程" (a lie — no retry fires when attemptHasContentOutput=true).
        // Replace the raw error with an honest partial-output text notice.
        if (msg.type === 'error' && isMalformedToolCallError(msg.error) && attemptHasContentOutput) {
          log.warn(
            { catId, error: msg.error },
            '[F215] Malformed after content output — replacing misleading error with partial-output notice',
          );
          const notice: AgentMessage = {
            type: 'text',
            catId: catId as CatId,
            content: `\n\n🐾 手抖了——最后一步没完成。上面的内容已经送到了，可以追问或让其他猫猫接着做。`,
            timestamp: Date.now(),
          };
          for await (const out of streamProcessedOutputs(notice)) {
            yield out;
          }
          continue;
        }

        if (
          suppressedMissingSessionError ||
          suppressedPromptLimitError ||
          suppressedContextOverflowError ||
          suppressedTransientCliError ||
          suppressedTimeoutError ||
          suppressedMalformedError
        ) {
          if (msg.type === 'done') {
            // F215 AC-C1: Seal malformed session before fresh retry.
            if (suppressedMalformedError && deps.sessionSealer && deps.sessionChainStore) {
              try {
                const activeRec = await deps.sessionChainStore.getActive(catId as CatId, threadId);
                if (activeRec) {
                  const sealResult = await deps.sessionSealer.requestSeal({
                    sessionId: activeRec.id,
                    reason: 'malformed_toolcall',
                  });
                  if (sealResult.accepted) {
                    sessionManager.delete(userId, catId, threadId).catch(() => {});
                    deps.sessionSealer.finalize({ sessionId: activeRec.id }).catch(() => {});
                    log.info(
                      { catId, threadId, invocationId, sessionId: activeRec.id },
                      '[F215] Sealed malformed session for fresh-context retry',
                    );
                  }
                }
              } catch {
                /* best-effort seal */
              }
            }
            shouldRetryWithoutSession = Boolean(
              suppressedMissingSessionError ||
                suppressedPromptLimitError ||
                suppressedContextOverflowError ||
                suppressedTimeoutError ||
                suppressedMalformedError,
            );
            shouldRetryOnTransientCliExit = Boolean(suppressedTransientCliError);
            break;
          }

          if (suppressedMissingSessionError) {
            for await (const out of streamProcessedOutputs(suppressedMissingSessionError)) {
              yield out;
            }
            suppressedMissingSessionError = undefined;
          }
          if (suppressedPromptLimitError) {
            for await (const out of streamProcessedOutputs(suppressedPromptLimitError)) {
              yield out;
            }
            suppressedPromptLimitError = undefined;
          }
          if (suppressedContextOverflowError) {
            for await (const out of streamProcessedOutputs(suppressedContextOverflowError)) {
              yield out;
            }
            suppressedContextOverflowError = undefined;
          }
          if (suppressedTransientCliError) {
            for await (const out of streamProcessedOutputs(suppressedTransientCliError)) {
              yield out;
            }
            suppressedTransientCliError = undefined;
          }
          if (suppressedTimeoutError) {
            for await (const out of streamProcessedOutputs(suppressedTimeoutError)) {
              yield out;
            }
            suppressedTimeoutError = undefined;
          }
          // F215: Clear malformed error — will be re-evaluated on retry.
          if (suppressedMalformedError) {
            suppressedMalformedError = undefined;
          }
        }

        // F149: Map provider_signal / liveness_signal → system_info for frontend delivery
        const deliveryMsg =
          msg.type === 'provider_signal' || msg.type === 'liveness_signal'
            ? { ...msg, type: 'system_info' as const }
            : msg;
        for await (const out of streamProcessedOutputs(deliveryMsg)) {
          yield out;
        }
        if (
          msg.type !== 'error' &&
          msg.type !== 'done' &&
          msg.type !== 'session_init' &&
          msg.type !== 'provider_signal' &&
          msg.type !== 'liveness_signal' &&
          msg.type !== 'status'
        ) {
          // F215 hotfix: attemptHasContentOutput must only be set by replay-sensitive types
          // (text / tool_use / tool_result). system_info (rate_limit_event / agent_loop /
          // timeout_diagnostics) and other metadata MUST NOT prevent malformed recovery —
          // they carry no model output that would be duplicated on retry.
          // Bug: system_info from rate_limit_event precedes malformed turn → sets
          // attemptHasContentOutput=true → malformed suppress guard !attemptHasContentOutput
          // fails → seal/fresh-retry/46接力 all skipped → bare malformed error leaks to user.
          if (isUserVisibleSessionOutput(msg)) {
            attemptHasContentOutput = true;
          }
          // Substantive = real model output, excludes system_info (e.g. timeout_diagnostics).
          if (msg.type !== 'system_info') {
            attemptHasSubstantiveOutput = true;
          }
          // F118 AC-C6: Reset consecutive restore failure counter on successful content
          if (deps.sessionChainStore && !didResetRestoreFailures) {
            didResetRestoreFailures = true; // only reset once per invocation
            try {
              const activeRec = await deps.sessionChainStore.getActive(catId as CatId, threadId);
              if (activeRec && (activeRec.consecutiveRestoreFailures ?? 0) > 0) {
                await deps.sessionChainStore.update(activeRec.id, {
                  consecutiveRestoreFailures: 0,
                  updatedAt: Date.now(),
                });
              }
            } catch {
              /* best-effort reset */
            }
          }
        }
      }

      if (shouldRetryWithoutSession && attempt + 1 < maxAttempts) {
        const retryReason = suppressedPromptLimitError
          ? 'prompt_token_limit'
          : suppressedContextOverflowError
            ? 'context_window_overflow'
            : suppressedTimeoutError
              ? 'cli_timeout'
              : suppressedMalformedError
                ? 'malformed_toolcall'
                : 'missing_session';
        log.info(
          {
            catId,
            threadId,
            invocationId,
            reason: retryReason,
            retryReason,
            attempt: attempt + 1,
            retryAttempt: attempt + 2,
            elapsedMs: Date.now() - attemptStartedAt,
            hadSessionId: Boolean(options.sessionId),
          },
          'cat retrying invoke (session self-heal)',
        );
        try {
          await sessionManager.delete(userId, catId, threadId);
        } catch {
          // Redis delete failure — best-effort only
        }
        // F118 AC-C6: Increment consecutive restore failure counter
        if (deps.sessionChainStore) {
          try {
            const activeRec = await deps.sessionChainStore.getActive(catId as CatId, threadId);
            if (activeRec) {
              await deps.sessionChainStore.update(activeRec.id, {
                consecutiveRestoreFailures: (activeRec.consecutiveRestoreFailures ?? 0) + 1,
                updatedAt: Date.now(),
              });
            }
          } catch {
            /* best-effort counter update */
          }
        }
        sessionId = undefined;
        // F118 P2-fix: Clear stale cliSessionId so retry diagnostics don't mis-attribute
        delete baseOptions.cliSessionId;
        // F-BLOAT P1: self-heal drops session → retry is now a fresh session.
        // Must re-inject systemPrompt since baseOptions may have omitted it
        // when the original attempt was a resume (injectSystemPrompt=false).
        if (params.systemPrompt && !baseOptions.systemPrompt) {
          baseOptions.systemPrompt = params.systemPrompt;
        }
        allowSessionRetry = false;
        continue;
      }
      if (shouldRetryOnTransientCliExit && attempt + 1 < maxAttempts) {
        log.info(
          {
            catId,
            threadId,
            invocationId,
            reason: 'transient_cli_exit',
            retryReason: 'transient_cli_exit',
            attempt: attempt + 1,
            retryAttempt: attempt + 2,
            elapsedMs: Date.now() - attemptStartedAt,
            hadSessionId: Boolean(options.sessionId),
          },
          'cat retrying invoke (transient CLI exit)',
        );
        allowTransientRetry = false;
        continue;
      }

      if (suppressedMissingSessionError) {
        for await (const out of streamProcessedOutputs(suppressedMissingSessionError)) {
          yield out;
        }
      }
      if (suppressedPromptLimitError) {
        for await (const out of streamProcessedOutputs(suppressedPromptLimitError)) {
          yield out;
        }
      }
      if (suppressedContextOverflowError) {
        for await (const out of streamProcessedOutputs(suppressedContextOverflowError)) {
          yield out;
        }
      }
      if (suppressedTransientCliError) {
        for await (const out of streamProcessedOutputs(suppressedTransientCliError)) {
          yield out;
        }
      }
      // F215 AC-C3/AC-D1: All retries exhausted with malformed result.
      // BLOCKING 1 fix: emit the relay card as a `text` message (user-visible) THEN emit
      // the `system_info` signal so route-serial can detect and push opus-4.6 to worklist.
      // This keeps the user-visible card decoupled from the routing signal.
      if (suppressedMalformedError) {
        log.warn(
          { catId, threadId, invocationId },
          '[F215] Malformed tool-call recovery exhausted — emitting 46接力 card (AC-C3)',
        );
        // 1. User-visible relay card (text type — front-end renders naturally)
        // BLOCKING 4 fix: removed "请重新发送请求" — relay is automatic.
        // P2 fix: neutral wording — don't promise relay success before route-serial verifies availability.
        const cardText = [
          '🙀 **Opus 4.8 炸毛了** —— 他这次手抖，工具调用格式写歪了，系统读不出来。',
          '放心，**不是猫咖的问题**，是这只猫在长对话里偶尔会犯的毛病；系统已触发自动恢复，将尝试切换到备用上下文重试（如可用）。',
          '',
          '`[展开技术细节 ▾]` 发生了什么：claude-opus-4-8 在长对话后段，偶尔把"工具调用"写成 AI 内部旧格式，Claude Code 识别不了 | 根因：Anthropic 模型的已知问题（#49747），与猫咖无关 | 猫咖怎么兜底：自动检测异常 → 隔离问题对话 → 触发备用恢复路径（如 Opus 4.6 可用则接力）',
        ].join('\n');
        for await (const out of streamProcessedOutputs({
          type: 'text' as const,
          catId,
          content: cardText,
          timestamp: Date.now(),
        })) {
          yield out;
        }
        // 2. Internal routing signal — route-serial consumes this to push opus-4.6 to worklist.
        // route-helpers.ts USER_FACING_SYSTEM_INFO_TYPES includes this type so route-serial
        // won't append a silent_completion after seeing it.
        for await (const out of streamProcessedOutputs({
          type: 'system_info' as const,
          catId,
          content: JSON.stringify({
            type: 'malformed_toolcall_relay_46',
            invocationId,
          }),
          timestamp: Date.now(),
        })) {
          yield out;
        }
        // AC-D1: Explicit final error (not silent empty return)
        for await (const out of streamProcessedOutputs({
          type: 'error' as const,
          catId,
          error: 'malformed_toolcall: Opus 4.8 炸毛，fresh-context 重试仍失败。系统将用 Opus 4.6 接班（AC-D1）',
          timestamp: Date.now(),
        })) {
          yield out;
        }
        // P1 #2 fix: synthesize terminal done — provider's done was consumed by the suppression
        // path (continue). Without this, route-serial's doneMsg stays null and direct
        // invokeSingleCat consumers never receive the terminal done/isFinal signal.
        for await (const out of streamProcessedOutputs({
          type: 'done' as const,
          catId,
          isFinal: isLastCat,
          timestamp: Date.now(),
        })) {
          yield out;
        }
      }
      break;
    }

    if (shouldTrackGeminiResumeFailures && Object.keys(resumeFailureCounts).length > 0) {
      const total = Object.values(resumeFailureCounts).reduce((sum, count) => sum + (count ?? 0), 0);
      for (const out of await processMessage({
        type: 'system_info' as const,
        catId,
        content: JSON.stringify({
          type: 'resume_failure_stats',
          catId,
          invocationId,
          sessionId: initialResumeSessionId,
          counts: resumeFailureCounts,
          total,
        }),
        timestamp: Date.now(),
      })) {
        await maybePersistTaskProgress(out);
        yield out;
      }
    }
    didComplete = true; // F118 AC-C5: Normal completion reached
  } catch (err) {
    // F152: Record error on invocation span + OTel log
    invocationSpan.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
    emitOtelLog('ERROR', 'invocation_error', { [AGENT_ID]: catId, [STATUS]: 'error' }, invocationSpan);

    // === CAT_ERROR 审计 (fire-and-forget, 缅因猫 review P2-3) ===
    const durationMs = Date.now() - startTime;
    auditLog
      .append({
        type: AuditEventTypes.CAT_ERROR,
        threadId,
        data: {
          catId,
          userId,
          invocationId,
          durationMs,
          error: err instanceof Error ? err.message : String(err),
        },
      })
      .catch((auditErr) => {
        log.warn({ threadId, invocationId, err: auditErr }, 'CAT_ERROR audit write failed');
      });

    hadError = true;
    didWriteAudit = true; // F118 AC-C5: Catch block wrote audit, don't double-write in finally
    yield {
      type: 'error' as const,
      catId,
      error: err instanceof Error ? err.message : String(err),
      timestamp: Date.now(),
    };
    await finalizeTaskProgress();
    const sc = invocationSpan.spanContext();
    const parentSid = params.routeSpan?.spanContext().spanId;
    yield {
      type: 'done' as const,
      catId,
      isFinal: isLastCat,
      timestamp: Date.now(),
      tracing: { traceId: sc.traceId, spanId: sc.spanId, ...(parentSid ? { parentSpanId: parentSid } : {}) },
    };
  } finally {
    // F153 Phase J AC-J4: drain any open tool spans whose tool_result never arrived
    // (abort / error / timeout). Mirrors PR #732 mention_dispatch abort-safety pattern.
    toolSpanTracker.endAllOrphans('aborted');

    // F089: Clear invocation hard timeout
    if (invocationTimer) clearTimeout(invocationTimer);

    // F118: Release session mutex (idempotent — safe if never acquired)
    sessionMutexRelease?.();

    if (openCodeRuntimeConfigPath) {
      const openCodeRuntimeConfigDir = dirname(openCodeRuntimeConfigPath);
      await rm(openCodeRuntimeConfigDir, { recursive: true, force: true }).catch((err) => {
        log.warn({ invocationId, path: openCodeRuntimeConfigDir, err }, 'Failed to remove OpenCode runtime config dir');
      });
    }

    // F118 AC-C5: Fallback audit for generator .return() path (#99)
    // If generator was force-returned (e.g. AbortController, client disconnect)
    // and the catch block didn't fire, write a fallback CAT_ERROR audit entry.
    if (!didWriteAudit && !hadError && !didComplete) {
      const durationMs = Date.now() - startTime;
      auditLog
        .append({
          type: AuditEventTypes.CAT_ERROR,
          threadId,
          data: {
            catId,
            userId,
            invocationId,
            durationMs,
            error: 'generator_returned_without_completion',
          },
        })
        .catch((auditErr) => {
          log.warn({ threadId, invocationId, err: auditErr }, 'Finally fallback CAT_ERROR audit write failed');
        });
    }

    await finalizeTaskProgress();

    // F152: Record invocation duration and decrement active count
    const finalDurationMs = Date.now() - startTime;
    const wasAbortedWithoutError = !didWriteAudit && !hadError && !didComplete;
    const otelStatus = hadError || wasAbortedWithoutError ? 'error' : 'ok';
    const otelAttrs = { [AGENT_ID]: catId, [OPERATION_NAME]: 'invoke', [STATUS]: otelStatus };
    invocationDuration.record(finalDurationMs / 1000, otelAttrs);
    activeInvocations.add(-1, { [AGENT_ID]: catId, [OPERATION_NAME]: 'invoke' });

    // F153: Product-level instruments
    invocationCompleted.add(1, { [AGENT_ID]: catId, [STATUS]: otelStatus });
    catResponseDuration.record(finalDurationMs / 1000, { [AGENT_ID]: catId, [STATUS]: otelStatus });
    if (threadCreatedAt) {
      threadDuration.record((Date.now() - threadCreatedAt) / 1000, { [AGENT_ID]: catId, [STATUS]: otelStatus });
    }

    // F089: Mark agent pane status when invocation completes
    if (deps.agentPaneRegistry?.getByInvocation(invocationId)) {
      if (hadError || wasAbortedWithoutError) {
        deps.agentPaneRegistry.markCrashed(invocationId, null);
      } else {
        deps.agentPaneRegistry.markDone(invocationId, 0);
      }
    }
    // F198 Phase C P1-1: mark bg carrier done (always, on any terminal state)
    deps.agentPaneRegistry?.markBgCarrierDone(invocationId);

    // F152: End invocation span + emit completion/error log through OTel
    // Three paths: (1) catch already handled, (2) yielded-error, (3) abort, (4) ok
    if (hadError && !didWriteAudit) {
      // Yielded-error path — catch didn't fire, so emit error here
      invocationSpan.setStatus({ code: SpanStatusCode.ERROR, message: 'invocation completed with error' });
      emitOtelLog('ERROR', 'invocation_error', { [AGENT_ID]: catId, [STATUS]: 'error' }, invocationSpan);
    } else if (wasAbortedWithoutError) {
      // Abort path — generator .return()'d without completion, consistent with audit CAT_ERROR
      invocationSpan.setStatus({ code: SpanStatusCode.ERROR, message: 'generator_returned_without_completion' });
      emitOtelLog('ERROR', 'invocation_aborted', { [AGENT_ID]: catId, [STATUS]: 'error' }, invocationSpan);
    } else if (didComplete) {
      invocationSpan.setStatus({ code: SpanStatusCode.OK });
      emitOtelLog('INFO', 'invocation_completed', { [AGENT_ID]: catId, [STATUS]: 'ok' }, invocationSpan);
    }
    invocationSpan.end();
  }
}
