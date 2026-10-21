/**
 * Agent Router
 * 解析 @ 提及，路由到对应的 Agent Service
 *
 * Features:
 * - 有 @ 提及时路由到指定猫 + 更新对话参与者
 * - 无 @ 提及时路由到最近回复的猫 (F078)
 * - 群组 mention: @all/@全体, @全体{breed}, @thread/@本帖 (F078)
 * - 无参与者的新对话默认路由到布偶猫 (opus)
 * - 支持中英文提及模式
 * - ideate intent + 多猫 → 并行独立思考 (routeParallel)
 * - execute intent 或单猫 → 串行执行 (routeSerial)
 * - Session 管理委托给 SessionManager
 *
 * IMPORTANT: threadId 约束
 * 所有调用入口（execute, executeWithContext）必须传入正确的 threadId。
 * 跨线程鉴权、消息存储、InvocationTracker 都依赖此参数。
 * 虽然参数可选（兼容测试），但生产代码必须显式传入。
 */

import type { CatId, CatRoutingError, MessageContent } from '@cat-cafe/shared';
import { catRegistry, deploymentDefaults, escapeRegExp } from '@cat-cafe/shared';
import type {
  RoutingPreviewReason,
  RoutingPreviewReasonKind,
  RoutingPreviewResponse,
} from '@cat-cafe/shared/routing-preview';
import type { SessionStore } from '@cat-cafe/shared/utils';
import { context as ctxApi, SpanStatusCode, trace } from '@opentelemetry/api';
import { getDefaultCatId, isCatAvailable } from '../../../../../config/cat-config-loader.js';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import {
  ROUTING_INTENT,
  ROUTING_STRATEGY,
  ROUTING_TARGET_CATS,
} from '../../../../../infrastructure/telemetry/genai-semconv.js';
import { inferRoutingContextIntent } from '../../../../routing-context/RoutingDispatchPreflightPort.js';
import type { IntentResult } from '../../context/IntentParser.js';
import { parseIntent, ROUTE_CONTROL_TAGS, stripIntentTags } from '../../context/IntentParser.js';
import type { IRuntimeSessionStore } from '../../runtime-session/RuntimeSessionStore.js';
import type { ContextEpochOwner } from '../../session/context/ContextEpochOwner.js';
import type { PresentationLedger } from '../../session/context/PresentationLedger.js';
import { SessionManager } from '../../session/SessionManager.js';
import type { ISessionSealer } from '../../session/SessionSealer.js';
import type { TranscriptReader } from '../../session/TranscriptReader.js';
import type { TranscriptWriter } from '../../session/TranscriptWriter.js';
import { DeliveryCursorStore } from '../../stores/ports/DeliveryCursorStore.js';
import type { IDraftStore } from '../../stores/ports/DraftStore.js';
import type { IMessageStore } from '../../stores/ports/MessageStore.js';
import type { ISessionChainStore } from '../../stores/ports/SessionChainStore.js';
import type { ITaskStore } from '../../stores/ports/TaskStore.js';
import type { IThreadStore, ThreadRoutingPolicyV1 } from '../../stores/ports/ThreadStore.js';
import { DEFAULT_THREAD_ID } from '../../stores/ports/ThreadStore.js';
import type { IWorkflowSopStore } from '../../stores/ports/WorkflowSopStore.js';
import { getTimelineOrderTime } from '../../stores/visibility.js';
import type {
  AgentMessage,
  AgentRouteIntent,
  AgentService,
  ClaudeCompactionHooksFactory,
  ToolExecutionPolicy,
} from '../../types.js';
import type { InvocationRegistry } from '../invocation/InvocationRegistry.js';
import {
  type InvocationCapacitySnapshot,
  resolveInvocationCapacitySnapshot,
} from '../invocation/invocation-capacity-snapshot.js';
import type { TaskProgressStore } from '../invocation/TaskProgressStore.js';
import type { AgentRegistry } from '../registry/AgentRegistry.js';
import type { AgentRegistrationFailure } from '../registry/AgentServiceUnavailableError.js';
import type { RouteExecutionOptions, RouteOptions, RouteStrategyDeps } from '../routing/route-helpers.js';
import { routeParallel } from '../routing/route-parallel.js';
import { routeSerial } from '../routing/route-serial.js';
import { appendContextAttachmentsToPrompt } from './context-attachment-prompt.js';
import { findLastUserMentions } from './last-user-mentions.js';

const log = createModuleLogger('agent-router');
const routeTracer = trace.getTracer('cat-cafe-api', '0.1.0');

const MENTION_TOKEN_BOUNDARY_RE = /[\s,.:;!?()[\]{}<>，。！？、：；（）【】《》「」『』〈〉]/;
const HANDLE_CONTINUATION_RE = /[a-z0-9_.-]/;
const QUOTE_BEFORE_MENTION_RE = /["'“”‘’]/;
const DOMAIN_SUFFIX_START_RE = /[\p{L}\p{N}]/u;
const BARE_URL_PREFIX_BEFORE_MENTION_RE = /(?:^|[^a-z0-9_-])(?:[a-z0-9-]+\.)+[a-z0-9-]+(?:\/[^\s@]*)*\/$/i;

function projectAgentRouteIntent(intent: IntentResult): AgentRouteIntent {
  return { intent: intent.intent, explicit: intent.explicit };
}
const ASCII_WORD_RE = /[a-z0-9]/i;
const QUOTE_SPAN_PAIRS: readonly [string, string][] = [
  ['"', '"'],
  ['“', '”'],
  ['‘', '’'],
  ['「', '」'],
  ['『', '』'],
];
const LINE_START_MENTION_PREFIX_RE = /^[ \t]*(?:(?:>\s*)|(?:[-*+][ \t]+)|(?:\d+[.)][ \t]+))*/;
const ROUTE_CONTROL_TAG_RE = new RegExp(
  `^#(?:${ROUTE_CONTROL_TAGS.map((tag) => escapeRegExp(tag)).join('|')})\\b`,
  'i',
);

/** Parsed mention with position for ordering */
interface ParsedMention {
  catId: CatId;
  position: number;
}

interface MentionPattern {
  pattern: string;
  catId: CatId;
}

type MarkdownMentionMarker = '*' | '_';

interface MarkdownMentionMarkerRun {
  marker: MarkdownMentionMarker;
  count: number;
}

/**
 * #969: Zero-width Unicode characters that LLMs may insert before mentions.
 * These are invisible in consoles but break line-start `@` detection.
 */
function isZeroWidthChar(code: number): boolean {
  return (
    code === 0x200b || // Zero Width Space
    code === 0x200c || // Zero Width Non-Joiner
    code === 0x200d || // Zero Width Joiner
    code === 0xfeff || // Zero Width No-Break Space (BOM)
    code === 0x00ad || // Soft Hyphen
    code === 0x2060 // Word Joiner
  );
}

function getRouteLineStart(line: string): number | null {
  let cursor = line.match(LINE_START_MENTION_PREFIX_RE)?.[0].length ?? 0;

  while (true) {
    while (line[cursor] === ' ' || line[cursor] === '\t') cursor++;
    const tag = line.slice(cursor).match(ROUTE_CONTROL_TAG_RE)?.[0];
    if (!tag) break;
    cursor += tag.length;
  }

  while (line[cursor] === ' ' || line[cursor] === '\t') cursor++;
  // #969: Skip zero-width chars and markdown bold/italic markers before @
  while (cursor < line.length && isZeroWidthChar(line.charCodeAt(cursor))) cursor++;
  while (cursor < line.length && (line[cursor] === '*' || line[cursor] === '_')) cursor++;
  while (cursor < line.length && isZeroWidthChar(line.charCodeAt(cursor))) cursor++;
  return line[cursor] === '@' ? cursor : null;
}

function findLineEnd(message: string, offset: number): number {
  let lineEnd = offset;
  while (lineEnd < message.length && message[lineEnd] !== '\r' && message[lineEnd] !== '\n') lineEnd++;
  return lineEnd;
}

function getNextLineOffset(message: string, lineEnd: number): number | null {
  if (lineEnd >= message.length) return null;
  return message[lineEnd] === '\r' && message[lineEnd + 1] === '\n' ? lineEnd + 2 : lineEnd + 1;
}

function forEachRouteCandidateInLine(
  line: string,
  offset: number,
  visit: (line: string, offset: number, candidate: number) => void,
): void {
  const routeStart = getRouteLineStart(line);
  if (routeStart === null) return;

  let candidate = routeStart;
  while (candidate >= 0) {
    if (candidate === routeStart || MENTION_TOKEN_BOUNDARY_RE.test(line[candidate - 1] ?? '')) {
      visit(line, offset, candidate);
    }
    candidate = line.indexOf('@', candidate + 1);
  }
}

function forEachRouteLineMentionCandidate(
  message: string,
  visit: (line: string, offset: number, candidate: number) => void,
) {
  let offset = 0;
  while (offset <= message.length) {
    const lineEnd = findLineEnd(message, offset);
    const line = message.slice(offset, lineEnd);
    forEachRouteCandidateInLine(line, offset, visit);
    const nextOffset = getNextLineOffset(message, lineEnd);
    if (nextOffset === null) break;
    offset = nextOffset;
  }
}

function pushRegexSpans(message: string, regex: RegExp, spans: Array<[number, number]>): void {
  for (const match of message.matchAll(regex)) {
    if (typeof match.index === 'number') spans.push([match.index, match.index + match[0].length]);
  }
}

function pushQuoteSpans(message: string, spans: Array<[number, number]>): void {
  for (const [open, close] of QUOTE_SPAN_PAIRS) {
    let offset = 0;
    while (offset < message.length) {
      const start = message.indexOf(open, offset);
      if (start < 0) break;
      const end = message.indexOf(close, start + open.length);
      if (end < 0) break;
      spans.push([start, end + close.length]);
      offset = end + close.length;
    }
  }
}

function isStraightSingleQuoteOpener(message: string, pos: number): boolean {
  const previous = message[pos - 1];
  if (previous === undefined) return true;
  return !ASCII_WORD_RE.test(previous);
}

function isStraightSingleQuoteCloser(message: string, pos: number): boolean {
  const next = message[pos + 1];
  if (next === undefined) return true;
  return !ASCII_WORD_RE.test(next);
}

function pushStraightSingleQuoteSpans(message: string, spans: Array<[number, number]>): void {
  let offset = 0;
  while (offset < message.length) {
    const start = message.indexOf("'", offset);
    if (start < 0) break;
    if (!isStraightSingleQuoteOpener(message, start)) {
      offset = start + 1;
      continue;
    }

    let closed = false;
    let search = start + 1;
    while (search < message.length) {
      const end = message.indexOf("'", search);
      if (end < 0) break;
      if (isStraightSingleQuoteCloser(message, end)) {
        spans.push([start, end + 1]);
        offset = end + 1;
        closed = true;
        break;
      }
      search = end + 1;
    }

    if (!closed) offset = start + 1;
  }
}

function buildMentionExclusionSpans(message: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  pushRegexSpans(message, /```[\s\S]*?```/g, spans);
  pushRegexSpans(message, /`[^`\n]+`/g, spans);
  pushRegexSpans(message, /^[ \t]*>[^\n]*/gm, spans);
  pushQuoteSpans(message, spans);
  pushStraightSingleQuoteSpans(message, spans);
  return spans;
}

function isInsideSpan(pos: number, spans: readonly [number, number][]): boolean {
  return spans.some(([start, end]) => pos >= start && pos < end);
}

function isUserMentionLeftBoundary(message: string, pos: number): boolean {
  if (pos === 0) return true;
  const prev = message[pos - 1];
  if (!prev) return true;
  return !HANDLE_CONTINUATION_RE.test(prev) && !QUOTE_BEFORE_MENTION_RE.test(prev);
}

function isMentionEndBoundary(message: string, end: number): boolean {
  const next = message[end];
  if (!next) return true;
  if (next === '.') {
    const suffixStart = message[end + 1];
    if (suffixStart !== undefined && DOMAIN_SUFFIX_START_RE.test(suffixStart)) return false;
  }
  if (MENTION_TOKEN_BOUNDARY_RE.test(next)) return true;
  return !HANDLE_CONTINUATION_RE.test(next);
}

function getOpeningRouteMarkdownMarkers(message: string, pos: number): MarkdownMentionMarkerRun | null {
  let cursor = pos - 1;
  while (cursor >= 0 && isZeroWidthChar(message.charCodeAt(cursor))) cursor--;

  const marker = message[cursor];
  if (marker !== '*' && marker !== '_') return null;

  let count = 0;
  while (cursor >= 0 && message[cursor] === marker) {
    count++;
    cursor--;
  }
  return { marker, count };
}

function skipClosingRouteMarkdownMarkers(
  message: string,
  end: number,
  openingMarkers: MarkdownMentionMarkerRun | null,
): number {
  if (!openingMarkers) return end;

  let cursor = end;
  let remaining = openingMarkers.count;
  while (remaining > 0) {
    while (cursor < message.length && isZeroWidthChar(message.charCodeAt(cursor))) cursor++;
    if (message[cursor] !== openingMarkers.marker) return end;
    cursor++;
    remaining--;
  }
  while (cursor < message.length && isZeroWidthChar(message.charCodeAt(cursor))) cursor++;
  return cursor;
}

function isUrlishMentionToken(message: string, pos: number): boolean {
  const tokenStart =
    Math.max(message.lastIndexOf(' ', pos), message.lastIndexOf('\n', pos), message.lastIndexOf('\t', pos)) + 1;
  const nextSpace = message.slice(pos).search(/\s/);
  const tokenEnd = nextSpace < 0 ? message.length : pos + nextSpace;
  const token = message.slice(tokenStart, tokenEnd);
  if (token.includes('://')) return true;
  if (token.toLowerCase().startsWith('www.')) return true;
  const beforeMention = message.slice(0, pos);
  return BARE_URL_PREFIX_BEFORE_MENTION_RE.test(beforeMention);
}

function forEachUserMentionCandidate(message: string, visit: (candidate: number) => void) {
  const excluded = buildMentionExclusionSpans(message);
  let candidate = message.indexOf('@');
  while (candidate >= 0) {
    if (
      !isInsideSpan(candidate, excluded) &&
      isUserMentionLeftBoundary(message, candidate) &&
      !isUrlishMentionToken(message, candidate)
    ) {
      visit(candidate);
    }
    candidate = message.indexOf('@', candidate + 1);
  }
}

function findMentionPatternAt(
  message: string,
  pos: number,
  patterns: readonly MentionPattern[],
  normalizePatternEnd?: (end: number) => number,
): MentionPattern | null {
  for (const entry of patterns) {
    const patternEnd = matchMentionPatternEnd(message, pos, entry.pattern);
    if (patternEnd === null) continue;
    const boundaryEnd = normalizePatternEnd ? normalizePatternEnd(patternEnd) : patternEnd;
    if (!isMentionEndBoundary(message, boundaryEnd)) continue;
    return entry;
  }
  return null;
}

function matchMentionPatternEnd(message: string, pos: number, pattern: string): number | null {
  let cursor = pos;
  for (let i = 0; i < pattern.length; i++) {
    while (cursor < message.length && isZeroWidthChar(message.charCodeAt(cursor))) cursor++;
    if (message[cursor] !== pattern[i]) return null;
    cursor++;
  }
  while (cursor < message.length && isZeroWidthChar(message.charCodeAt(cursor))) cursor++;
  return cursor;
}

function recordRouteLineMentions(
  message: string,
  patterns: readonly MentionPattern[],
  seenCats: Set<string>,
  mentions: ParsedMention[],
): void {
  const excluded = buildMentionExclusionSpans(message);
  forEachRouteLineMentionCandidate(message, (_line, lineOffset, candidate) => {
    const position = lineOffset + candidate;
    if (isInsideSpan(position, excluded)) return;
    const openingMarkers = getOpeningRouteMarkdownMarkers(message, position);
    const matched = findMentionPatternAt(message, position, patterns, (end) =>
      skipClosingRouteMarkdownMarkers(message, end, openingMarkers),
    );
    if (matched) recordResolvedMention(matched.catId, position, seenCats, mentions);
  });
}

function recordResolvedMention(catId: CatId, position: number, seenCats: Set<string>, mentions: ParsedMention[]): void {
  const key = catId as string;
  if (!seenCats.has(key)) {
    seenCats.add(key);
    mentions.push({ catId, position });
    return;
  }

  const existing = mentions.find((mention) => String(mention.catId) === key);
  if (existing && position < existing.position) {
    existing.position = position;
  }
}

/**
 * Build mention aliases and speech regex from the current cat configs.
 * Must be called after catRegistry is populated (not at module load time).
 */
function buildMentionData(configs: Record<string, import('@cat-cafe/shared').CatConfig>) {
  const mentionAliases = Array.from(
    new Set(
      Object.values(configs).flatMap((config) => config.mentionPatterns.map((pattern) => pattern.replace(/^@/, ''))),
    ),
  ).sort((a, b) => b.length - a.length);

  const speechMentionRe = new RegExp(
    [
      '(^|\\s)',
      '(?:at|艾特|@\\s*[。｡\\.．])',
      '\\s*(?:咱的|我的)?\\s*',
      `(${mentionAliases.map(escapeRegExp).join('|')})`,
      '(?=$|\\s|[，。！？、,.:：;；])',
    ].join(''),
    'gi',
  );

  return { mentionAliases, speechMentionRe };
}

/**
 * Options for AgentRouter constructor
 */
export interface AgentRouterOptions {
  resolveTrustedImagePath?: (hmrId: string) => Promise<string | undefined>;
  agentRegistry: AgentRegistry;
  registry: InvocationRegistry;
  dotReplyTarget?: (
    source: import('../../cloud-bridge/dot/dot-reply-authority.js').DotReplyCandidate,
  ) => Promise<boolean>;
  messageStore: IMessageStore;
  /** F045 Gap #4: Redis-backed task progress snapshots */
  taskProgressStore?: TaskProgressStore;
  sessionStore?: SessionStore;
  deliveryCursorStore?: DeliveryCursorStore;
  threadStore?: IThreadStore;
  /** F24: Session chain store for context health tracking */
  sessionChainStore?: ISessionChainStore;
  /** F296 B3b-1: persistent context epoch and cold/hot mode owner. */
  contextEpochOwner?: ContextEpochOwner;
  /** F296: authenticated Claude project-hook readiness from API bootstrap. */
  hookAuthenticationReady?: boolean | (() => boolean);
  /** F296: project-local PreCompact carrier readiness for the invocation workspace. */
  claudeProjectHookCarrierReady?: boolean | ((projectRoot: string) => boolean);
  /** F117 K2: in-process compaction hooks for the Claude Agent SDK carrier. */
  claudeCompactionHooks?: ClaudeCompactionHooksFactory;
  /** F296 B3b-2: shared provider-presentation delivery ledger. */
  presentationLedger?: PresentationLedger;
  /** F293: owner-scoped sparse routing projection consumed by provider generation. */
  routingContextPromptProjection?: import('../../../../routing-context/RoutingContextPromptProjector.js').RoutingContextPromptProjectionPort;
  /** F293: shared actual-send preflight over the same resolver/catalog graph. */
  routingDispatchPreflight?: import('../../../../routing-context/RoutingDispatchPreflightPort.js').RoutingDispatchPreflightPort;
  /** F293: durable dispatch terminal observer over the same routing signal graph. */
  routingDispatchSignalObserver?: import('../../../../routing-context/RoutingDispatchSignalContract.js').RoutingDispatchTerminalObserver;
  /** F276: terminal disposition authority for person-memory write opportunities. */
  writeOpportunityTerminalLedger?: import('../invocation/invoke-single-cat.js').InvocationDeps['writeOpportunityTerminalLedger'];
  /** F276: reservation and delivery authority for person-memory write opportunities. */
  writeOpportunityDeliveryStore?: import('../invocation/invoke-single-cat.js').InvocationDeps['writeOpportunityDeliveryStore'];
  /** F211 Phase A2: runtime sidecar for provider runtime session metadata */
  runtimeSessionStore?: IRuntimeSessionStore;
  /** F24 Phase C: Transcript writer for event recording */
  transcriptWriter?: TranscriptWriter;
  /** F24 Phase D: Transcript reader for bootstrap injection */
  transcriptReader?: TranscriptReader;
  /** F24 Phase B: Session sealer for auto-seal */
  sessionSealer?: ISessionSealer;
  /** #80: Streaming draft persistence store */
  draftStore?: IDraftStore;
  /** F065: Task store for bootstrap task snapshot injection */
  taskStore?: ITaskStore;
  /** RFC A79: canonical exact-run situation projection for agent context. */
  threadExecutionSituationSource?: import('../invocation/thread-execution-situation.js').ThreadExecutionSituationSource;
  /** F073 P4: Workflow SOP store for stage hint injection */
  workflowSopStore?: IWorkflowSopStore;
  /** F070 Phase 3a: Execution digest store for dispatch backflow */
  executionDigestStore?: import('../../../../projects/execution-digest-store.js').ExecutionDigestStore;
  /** F079 Bug 2: Socket manager for real-time vote result broadcast */
  socketManager?: import('../../../../../infrastructure/websocket/SocketManager.js').SocketManager;
  /** F089 Phase 2: tmux gateway for agent-in-pane execution */
  tmuxGateway?: import('../../../../terminal/tmux-gateway.js').TmuxGateway;
  /** F089 Phase 2: agent pane registry for observability */
  agentPaneRegistry?: import('../../../../terminal/agent-pane-registry.js').AgentPaneRegistry;
  /** F129: Pack store for loading active packs at invocation time */
  packStore?: import('../../../../packs/PackStore.js').PackStore;
  /** F148: Evidence store for hierarchical context recall */
  evidenceStore?: import('../../../../memory/interfaces.js').IEvidenceStore;
  /** F282 Phase A: lane-neutral proactive memory prompt carrier. */
  proactiveMemoryNudgeService?: import('../../../../memory/ProactiveMemoryNudgeService.js').ProactiveMemoryNudgeService;
  /** F281 Phase C: direct-owner exact-subject feedback projection. */
  humanDispositionFeedbackContextService?: import('../../../../human-disposition/HumanDispositionFeedbackContextService.js').HumanDispositionFeedbackContextService;
  /** F150: Tool usage counter */
  toolUsageCounter?: import('../../tool-usage/ToolUsageCounter.js').ToolUsageCounter;
  /** F188 Phase F AC-F10: Tool event log (append-only sequence) */
  toolEventLog?: import('../../tool-usage/ToolEventLog.js').ToolEventLog;
  /** F188 Phase F AC-F10 (AS-4): Skill load event log */
  skillLoadEventLog?: import('../../tool-usage/SkillLoadEventLog.js').SkillLoadEventLog;
  /** F155 B-4: Independent guide session store */
  guideSessionStore?: import('../../../../guides/GuideSessionRepository.js').IGuideSessionStore;
  /** F155 B-6: Dismiss tracker for guide offer suppression */
  dismissTracker?: import('../../../../guides/GuideDismissTracker.js').IGuideDismissTracker;
  /** F093: World context provider for world-building mode */
  worldContextProvider?: import('../../../../world/WorldContextProvider.js').WorldContextProvider;
  /** F093: World store for thread→world lookup */
  worldStore?: import('../../../../world/interfaces.js').IWorldStore;
  /** F233 Phase B (B2): ball-custody ingest（注入 route deps 供旁路写球权事件，fail-open） */
  ballCustody?: import('../../../../ball-custody/BallCustodyIngest.js').IBallCustodyIngest;
  /** F167 Phase T: read-only turn-custody projection consumed by the structured stop gate. */
  turnCustodyProjectionService?: import('../../../../ball-custody/TurnCustodyProjectionService.js').TurnCustodyProjectionService;
  /** F222: Frustration auto-issue store */
  frustrationIssueStore?: import('../../stores/ports/FrustrationIssueStore.js').IFrustrationIssueStore;
  /** F229: Concierge config store for duty-cat岗位 prompt injection */
  conciergeConfigStore?: import('../../../../concierge/ConciergeConfigStore.js').IConciergeConfigStore;
  /** F229 Phase B: TriagePlan store for triage-plan marker → confirm/cancel card actions */
  conciergeTriagePlanStore?: import('../../../../concierge/ConciergeTriagePlanStore.js').IConciergeTriagePlanStore;
  /** F247 AC-B1c-3 PR-C: Cloud invoke bridge for @gpt-pro → ChatGPT dispatch */
  cloudInvokeBridge?: import('../../cloud-bridge/types.js').ICloudInvokeBridge;
  /** F247: shared server-custodied source-bound return authorization. */
  cloudReturnGrantStore?: import('../../cloud-bridge/cloud-return-grant.js').CloudReturnGrantStore;
  /** Durable per-child execution lifecycle; independent from callback-auth registry TTL. */
  turnExecutionStore?: import('../../stores/ports/TurnExecutionStore.js').ITurnExecutionStore;
  /** F254 Phase C: Freshness state store for carrier tier persistence */
  freshnessStateStore?: import('../../freshness/FreshnessInvocationStateStore.js').FreshnessInvocationStateStore;
  /** F306: canonical cross-provider request/response surface. */
  runtimeInteractionPort?: import('../../../../runtime-interaction/ports/RuntimeInteractionPort.js').RuntimeInteractionPort;
  /** F254 Phase D (AC-D4): Freshness event log for stream output audit trail */
  freshnessEventLog?: import('../../freshness/FreshnessAttentionEventLog.js').FreshnessAttentionEventLog;
  /** F254 Phase E: persistent closure + atomic MessageStore output commit. */
  freshnessOutputCommitCoordinator?: import('../../freshness/glass-box/FreshnessOutputCommitCoordinator.js').FreshnessOutputCommitCoordinator;
  /** F237 Phase 2 (AC-P2-8): Injection trace store for pipeline observability */
  injectionTraceStore?: import('../../../../prompt-hooks/InjectionTraceStore.js').InjectionTraceStore;
  /** F276: typed rich-card discovery + owner-scoped live proposal status projection. */
  personMemoryProposalStatusContextResolver?: import('../../../../memory/people/PersonMemoryProposalStatusContextResolver.js').PersonMemoryProposalStatusContextResolver;
  /** F287: invocation-bound Cue Plane adapter. */
  memoryCuePromptService?: import('../../../../memory/cue/MemoryCueInvocationPromptService.js').MemoryCueInvocationPromptResolver;
  profileCueOpportunitySource?: import('../../../../memory/cue/sources/ProfileMemoryCueSource.js').ProfileMemoryCueSource;
  threadOverviewOpportunitySource?: import('../../../../memory/cue/sources/ThreadOverviewMemoryCueSource.js').ThreadOverviewMemoryCueSource;
  eventCueOpportunitySource?: import('../../../../memory/cue/sources/EventMemoryCueSource.js').EventMemoryCueSource;
  /** F231 canonical profile owner for F299 source-lifecycle binding. */
  profileRepository?: import('../../profile/ProfileRepository.js').FileProfileRepository;
  /** Durable source admission for route-serial occupied-slot Queue fallback. */
}

/**
 * Router that parses @ mentions and routes to appropriate agent services
 */
export class AgentRouter {
  private services: Record<string, AgentService>;
  private unavailableServices: ReadonlyMap<string, AgentRegistrationFailure> = new Map();
  private registry: InvocationRegistry;
  private messageStore: IMessageStore;
  private resolveTrustedImagePath?: (hmrId: string) => Promise<string | undefined>;
  private sessionManager: SessionManager;
  private deliveryCursorStore: DeliveryCursorStore;
  private threadStore: IThreadStore | null;
  private sessionChainStore: ISessionChainStore | undefined;
  private contextEpochOwner: ContextEpochOwner | undefined;
  private hookAuthenticationReady: boolean | (() => boolean);
  private claudeProjectHookCarrierReady: boolean | ((projectRoot: string) => boolean);
  private claudeCompactionHooks: ClaudeCompactionHooksFactory | undefined;
  private presentationLedger: PresentationLedger | undefined;
  private routingContextPromptProjection?: import('../../../../routing-context/RoutingContextPromptProjector.js').RoutingContextPromptProjectionPort;
  private routingDispatchPreflight?: import('../../../../routing-context/RoutingDispatchPreflightPort.js').RoutingDispatchPreflightPort;
  private routingDispatchSignalObserver?: import('../../../../routing-context/RoutingDispatchSignalContract.js').RoutingDispatchTerminalObserver;
  private writeOpportunityTerminalLedger?: import('../invocation/invoke-single-cat.js').InvocationDeps['writeOpportunityTerminalLedger'];
  private writeOpportunityDeliveryStore?: import('../invocation/invoke-single-cat.js').InvocationDeps['writeOpportunityDeliveryStore'];
  private runtimeSessionStore: IRuntimeSessionStore | undefined;
  private transcriptWriter: TranscriptWriter | undefined;
  private transcriptReader: TranscriptReader | undefined;
  private sessionSealer: ISessionSealer | undefined;
  private draftStore: IDraftStore | undefined;
  private taskProgressStore: TaskProgressStore | undefined;
  private taskStore: ITaskStore | undefined;
  private threadExecutionSituationSource?: import('../invocation/thread-execution-situation.js').ThreadExecutionSituationSource;
  private workflowSopStore: IWorkflowSopStore | undefined;
  private executionDigestStore:
    | import('../../../../projects/execution-digest-store.js').ExecutionDigestStore
    | undefined;
  private socketManager: import('../../../../../infrastructure/websocket/SocketManager.js').SocketManager | undefined;
  private tmuxGateway: import('../../../../terminal/tmux-gateway.js').TmuxGateway | undefined;
  private agentPaneRegistry: import('../../../../terminal/agent-pane-registry.js').AgentPaneRegistry | undefined;
  private packStore?: import('../../../../packs/PackStore.js').PackStore;
  private evidenceStore?: import('../../../../memory/interfaces.js').IEvidenceStore;
  private proactiveMemoryNudgeService?: import('../../../../memory/ProactiveMemoryNudgeService.js').ProactiveMemoryNudgeService;
  private humanDispositionFeedbackContextService?: import('../../../../human-disposition/HumanDispositionFeedbackContextService.js').HumanDispositionFeedbackContextService;
  /** F150 */
  private toolUsageCounter?: import('../../tool-usage/ToolUsageCounter.js').ToolUsageCounter;
  /** F188 Phase F AC-F10 */
  private toolEventLog?: import('../../tool-usage/ToolEventLog.js').ToolEventLog;
  /** F188 Phase F AC-F10 AS-4 */
  private skillLoadEventLog?: import('../../tool-usage/SkillLoadEventLog.js').SkillLoadEventLog;
  /** F155 B-4 */
  private guideSessionStore?: import('../../../../guides/GuideSessionRepository.js').IGuideSessionStore;
  /** F155 B-6 */
  private dismissTracker?: import('../../../../guides/GuideDismissTracker.js').IGuideDismissTracker;
  /** F093 */
  private worldContextProvider?: import('../../../../world/WorldContextProvider.js').WorldContextProvider;
  private worldStore?: import('../../../../world/interfaces.js').IWorldStore;
  private ballCustody?: import('../../../../ball-custody/BallCustodyIngest.js').IBallCustodyIngest;
  private turnCustodyProjectionService?: import('../../../../ball-custody/TurnCustodyProjectionService.js').TurnCustodyProjectionService;
  /** F222 */
  private frustrationIssueStore?: import('../../stores/ports/FrustrationIssueStore.js').IFrustrationIssueStore;
  /** F229 */
  private conciergeConfigStore?: import('../../../../concierge/ConciergeConfigStore.js').IConciergeConfigStore;
  /** F229 Phase B */
  private conciergeTriagePlanStore?: import('../../../../concierge/ConciergeTriagePlanStore.js').IConciergeTriagePlanStore;
  /** F247 AC-B1c-3 PR-C */
  private dotReplyTarget?: AgentRouterOptions['dotReplyTarget'];
  private cloudInvokeBridge?: import('../../cloud-bridge/types.js').ICloudInvokeBridge;
  private cloudReturnGrantStore?: import('../../cloud-bridge/cloud-return-grant.js').CloudReturnGrantStore;
  private turnExecutionStore?: import('../../stores/ports/TurnExecutionStore.js').ITurnExecutionStore;
  /** F254 Phase C */
  private freshnessStateStore?: import('../../freshness/FreshnessInvocationStateStore.js').FreshnessInvocationStateStore;
  /** F254 D2 */
  /** F306 */
  private runtimeInteractionPort?: import('../../../../runtime-interaction/ports/RuntimeInteractionPort.js').RuntimeInteractionPort;
  /** F254 Phase D (AC-D4) */
  private freshnessEventLog?: import('../../freshness/FreshnessAttentionEventLog.js').FreshnessAttentionEventLog;
  /** F254 Phase E */
  private freshnessOutputCommitCoordinator?: import('../../freshness/glass-box/FreshnessOutputCommitCoordinator.js').FreshnessOutputCommitCoordinator;
  /** F237 Phase 2 (AC-P2-8) */
  private injectionTraceStore?: import('../../../../prompt-hooks/InjectionTraceStore.js').InjectionTraceStore;
  /** F276 */
  private personMemoryProposalStatusContextResolver?: import('../../../../memory/people/PersonMemoryProposalStatusContextResolver.js').PersonMemoryProposalStatusContextResolver;
  /** F287 */
  private memoryCuePromptService?: import('../../../../memory/cue/MemoryCueInvocationPromptService.js').MemoryCueInvocationPromptResolver;
  private profileCueOpportunitySource?: import('../../../../memory/cue/sources/ProfileMemoryCueSource.js').ProfileMemoryCueSource;
  private threadOverviewOpportunitySource?: import('../../../../memory/cue/sources/ThreadOverviewMemoryCueSource.js').ThreadOverviewMemoryCueSource;
  private eventCueOpportunitySource?: import('../../../../memory/cue/sources/EventMemoryCueSource.js').EventMemoryCueSource;
  private profileRepository?: import('../../profile/ProfileRepository.js').FileProfileRepository;
  private speechMentionRe: RegExp;

  private rebuildRuntimeCaches(agentRegistry: AgentRegistry): void {
    this.unavailableServices = agentRegistry.getAllUnavailableEntries();
    this.services = {};
    for (const [catId, service] of agentRegistry.getAllEntries()) {
      this.services[catId] = service;
    }
    const allConfigs = catRegistry.getAllConfigs();
    const { speechMentionRe } = buildMentionData(allConfigs);
    this.speechMentionRe = speechMentionRe;
  }

  constructor(options: AgentRouterOptions) {
    this.services = {};
    this.speechMentionRe = /$^/;
    this.rebuildRuntimeCaches(options.agentRegistry);

    this.registry = options.registry;
    this.messageStore = options.messageStore;
    this.resolveTrustedImagePath = options.resolveTrustedImagePath;
    this.sessionManager = new SessionManager(options.sessionStore);
    // #1200 P2-3: wire cursor canonicalizer for v1→v2 async resolution
    const canonicalizer = options.messageStore.canonicalizeCursor
      ? (msgId: string, threadId: string) => Promise.resolve(options.messageStore.canonicalizeCursor!(msgId, threadId))
      : undefined;
    this.deliveryCursorStore =
      options.deliveryCursorStore ?? new DeliveryCursorStore(options.sessionStore, canonicalizer);
    this.threadStore = options.threadStore ?? null;
    this.sessionChainStore = options.sessionChainStore;
    this.contextEpochOwner = options.contextEpochOwner;
    this.hookAuthenticationReady = options.hookAuthenticationReady ?? false;
    this.claudeProjectHookCarrierReady = options.claudeProjectHookCarrierReady ?? false;
    this.claudeCompactionHooks = options.claudeCompactionHooks;
    this.presentationLedger = options.presentationLedger;
    this.routingContextPromptProjection = options.routingContextPromptProjection;
    this.routingDispatchPreflight = options.routingDispatchPreflight;
    this.routingDispatchSignalObserver = options.routingDispatchSignalObserver;
    this.writeOpportunityTerminalLedger = options.writeOpportunityTerminalLedger;
    this.writeOpportunityDeliveryStore = options.writeOpportunityDeliveryStore;
    this.runtimeSessionStore = options.runtimeSessionStore;
    this.transcriptWriter = options.transcriptWriter;
    this.transcriptReader = options.transcriptReader;
    this.sessionSealer = options.sessionSealer;
    this.draftStore = options.draftStore;
    this.taskProgressStore = options.taskProgressStore;
    this.taskStore = options.taskStore;
    this.threadExecutionSituationSource = options.threadExecutionSituationSource;
    this.workflowSopStore = options.workflowSopStore;
    this.executionDigestStore = options.executionDigestStore;
    this.socketManager = options.socketManager;
    this.tmuxGateway = options.tmuxGateway;
    this.agentPaneRegistry = options.agentPaneRegistry;
    this.packStore = options.packStore;
    this.evidenceStore = options.evidenceStore;
    this.proactiveMemoryNudgeService = options.proactiveMemoryNudgeService;
    this.humanDispositionFeedbackContextService = options.humanDispositionFeedbackContextService;
    this.toolUsageCounter = options.toolUsageCounter;
    this.toolEventLog = options.toolEventLog;
    this.skillLoadEventLog = options.skillLoadEventLog;
    this.guideSessionStore = options.guideSessionStore;
    this.dismissTracker = options.dismissTracker;
    this.worldContextProvider = options.worldContextProvider;
    this.worldStore = options.worldStore;
    this.ballCustody = options.ballCustody;
    this.turnCustodyProjectionService = options.turnCustodyProjectionService;
    this.frustrationIssueStore = options.frustrationIssueStore;
    this.conciergeConfigStore = options.conciergeConfigStore;
    this.conciergeTriagePlanStore = options.conciergeTriagePlanStore;
    this.dotReplyTarget = options.dotReplyTarget;
    this.cloudInvokeBridge = options.cloudInvokeBridge;
    this.cloudReturnGrantStore = options.cloudReturnGrantStore;
    this.turnExecutionStore = options.turnExecutionStore;
    this.freshnessStateStore = options.freshnessStateStore;
    this.runtimeInteractionPort = options.runtimeInteractionPort;
    this.freshnessEventLog = options.freshnessEventLog;
    this.freshnessOutputCommitCoordinator = options.freshnessOutputCommitCoordinator;
    this.injectionTraceStore = options.injectionTraceStore;
    this.personMemoryProposalStatusContextResolver = options.personMemoryProposalStatusContextResolver;
    this.memoryCuePromptService = options.memoryCuePromptService;
    this.profileCueOpportunitySource = options.profileCueOpportunitySource;
    this.eventCueOpportunitySource = options.eventCueOpportunitySource;
    this.threadOverviewOpportunitySource = options.threadOverviewOpportunitySource;
    this.profileRepository = options.profileRepository;
  }

  refreshFromRegistry(agentRegistry: AgentRegistry): void {
    this.rebuildRuntimeCaches(agentRegistry);
  }

  /** Exact concrete carrier truth; absence remains explicit and fail-closed. */
  freshnessCarrierCapability(catId: CatId): import('../../types.js').AgentFreshnessCarrierCapability {
    return (
      this.services[catId]?.freshnessCarrierCapability?.() ?? {
        provider: 'other',
        carrier: 'other',
        deliverySemantics: 'undeclared',
        activeInvocationGuidance: 'undeclared',
      }
    );
  }

  /** #1208: exact context capability of the concrete service/carrier. */
  contextCapability(catId: CatId): import('../../types.js').AgentContextCapability {
    return (
      this.services[catId]?.contextCapability?.() ?? {
        provider: 'unknown',
        carrier: 'unknown',
        reportsRuntimeWindow: false,
        authoritativeUsage: false,
        usageTelemetry: 'unavailable',
        nativeWindowControl: false,
        nativeCompressionControl: false,
        observesCompression: false,
        reason: 'No concrete context capability is registered for this member',
      }
    );
  }

  /** #1208: Hub projection from the same concrete service snapshot used by invocations. */
  contextCapacitySnapshot(catId: CatId): InvocationCapacitySnapshot | undefined {
    const service = this.services[catId];
    return service ? resolveInvocationCapacitySnapshot({ catId, service }) : undefined;
  }

  /** Capability of the actual routable service; does not admit any particular invocation. */
  supportsToolExecutionPolicy(catId: string, policy: ToolExecutionPolicy): boolean {
    return this.isRoutableCat(catId) && this.services[catId]?.supportsToolExecutionPolicy?.(policy) === true;
  }

  private isRoutableCat(catId: string | null | undefined): catId is CatId {
    return typeof catId === 'string' && Object.hasOwn(this.services, catId) && isCatAvailable(catId);
  }

  private filterRoutableCats(catIds: Iterable<string | null | undefined>): CatId[] {
    const filtered: CatId[] = [];
    const seen = new Set<string>();
    for (const catId of catIds) {
      if (!this.isRoutableCat(catId)) continue;
      if (seen.has(catId)) continue;
      seen.add(catId);
      filtered.push(catId);
    }
    return filtered;
  }

  private filterKnownCats(catIds: Iterable<string | null | undefined>): CatId[] {
    const configs = catRegistry.getAllConfigs();
    return [...new Set(catIds)].filter(
      (catId): catId is CatId => typeof catId === 'string' && Object.hasOwn(configs, catId),
    );
  }

  /**
   * F294: validate an explicit target set without parsing prose or applying fallback routing.
   * Validate catalog identity, independently of executable services. Unknown explicit IDs
   * invalidate the set; known members retain normal execution/failure settlement.
   */
  async resolveExplicitTargets(
    requestedCatIds: readonly string[],
    threadId: string,
    options?: { persist?: boolean },
  ): Promise<CatId[]> {
    const resolved = this.filterKnownCats(requestedCatIds);
    if (resolved.length !== requestedCatIds.length) return [];
    if (options?.persist && this.threadStore) {
      await this.threadStore.addParticipants(threadId, resolved);
    }
    return resolved;
  }

  /**
   * Canonical target resolution for public conversation work.
   *
   * Common send resolves before atomic Message + Queue admission. Drain may
   * reuse the policy, but must keep any already-bound Queue recipient set.
   * Still-routable explicit members keep their original order. Otherwise use
   * the same conversation policy shown by the composer, including historical
   * user mentions, healthy repliers and preferences. Existing history does not
   * need newly introduced response lifecycle metadata to retain its recipient.
   */
  async resolveConversationTargetsAtAdmission(
    requestedCatIds: readonly string[],
    threadId: string,
    content = '',
  ): Promise<CatId[]> {
    const explicit = this.filterRoutableCats(requestedCatIds);
    if (explicit.length > 0) return explicit;
    return (await this.resolveImplicitTargetPreview(content, threadId)).targetCats;
  }

  /** Public send parses prose once, then shares the existing conversation fallback. */
  async resolveSendTargets(
    requested: readonly string[],
    threadId: string,
    content = '',
    exact = false,
  ): Promise<CatId[]> {
    if (requested.length > 0 && (await this.resolveExplicitTargets(requested, threadId)).length !== requested.length) {
      throw new Error('Invalid explicit member identity');
    }
    if (exact) return this.resolveExplicitTargets(requested, threadId);
    const targets =
      requested.length > 0
        ? requested
        : (await this.resolveTargetsAndIntent(content, threadId, { persist: false, allowFallback: false })).targetCats;
    return this.resolveConversationTargetsAtAdmission(targets, threadId, content);
  }

  /** Pick a deterministic fallback cat when policy filters out all candidates. */
  private pickFallbackCat(exclude: Set<string>): CatId | null {
    const def = getDefaultCatId() as string;
    if (!exclude.has(def) && this.isRoutableCat(def)) return def as CatId;

    for (const id of Object.keys(this.services).sort()) {
      if (!exclude.has(id) && this.isRoutableCat(id)) return id as CatId;
    }
    return null;
  }

  /** Apply thread routingPolicy (if any) to a candidate target list. */
  private applyThreadRoutingPolicy(
    thread: { routingPolicy?: ThreadRoutingPolicyV1 } | null | undefined,
    message: string,
    candidates: CatId[],
  ): CatId[] {
    const routableCandidates = this.filterRoutableCats(candidates);
    const scope = inferRoutingContextIntent(message);
    if (!scope) {
      if (routableCandidates.length > 0) return routableCandidates;
      const fallback = this.pickFallbackCat(new Set());
      return fallback ? [fallback] : [];
    }

    const policy = thread?.routingPolicy;
    if (!policy || policy.v !== 1 || !policy.scopes) {
      if (routableCandidates.length > 0) return routableCandidates;
      const fallback = this.pickFallbackCat(new Set());
      return fallback ? [fallback] : [];
    }

    const rule = policy.scopes[scope];
    if (!rule) {
      if (routableCandidates.length > 0) return routableCandidates;
      const fallback = this.pickFallbackCat(new Set());
      return fallback ? [fallback] : [];
    }
    if (typeof rule.expiresAt === 'number' && rule.expiresAt > 0 && rule.expiresAt < Date.now()) {
      if (routableCandidates.length > 0) return routableCandidates;
      const fallback = this.pickFallbackCat(new Set());
      return fallback ? [fallback] : [];
    }

    // Defensive guard: data might be malformed from external persistence.
    const avoidList = Array.isArray(rule.avoidCats) ? rule.avoidCats : [];
    const preferList = Array.isArray(rule.preferCats) ? rule.preferCats : [];
    const avoid = new Set(avoidList.map((id) => String(id)));
    const prefer = preferList.map((id) => String(id)).filter((id) => !avoid.has(id));

    const filtered = routableCandidates.filter((id) => !avoid.has(id as string));
    const out: CatId[] = [];
    const seen = new Set<string>();

    for (const id of prefer) {
      if (!this.isRoutableCat(id)) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id as CatId);
    }

    for (const id of filtered) {
      const sid = id as string;
      if (seen.has(sid)) continue;
      seen.add(sid);
      out.push(id);
    }

    if (out.length > 0) return out;

    const fallback = this.pickFallbackCat(avoid);
    return fallback ? [fallback] : routableCandidates;
  }

  /** Normalize speech patterns like "at 布偶" → "@布偶" */
  private normalizeSpeechMentions(message: string): string {
    return message.replace(this.speechMentionRe, (_match, prefix: string, mention: string) => `${prefix}@${mention}`);
  }

  /**
   * F32-b: Parse @mentions with longest-match-first + token boundary.
   * F182 KD-10: match-time resolver check (different patch from a2a-mentions pattern-build stage).
   * Raw variant returns ParsedMention[] with position info for order-aware merging.
   */
  private parseMentionsRaw(message: string): { mentions: ParsedMention[]; routing_warnings: CatRoutingError[] } {
    const lowerMessage = message.toLowerCase();
    const speechRouteMessage = this.normalizeSpeechMentions(message).toLowerCase();

    // 1. Collect all mentionPatterns → catId, sorted by length descending
    const allPatterns: MentionPattern[] = [];
    const allConfigs = catRegistry.getAllConfigs();
    for (const config of Object.values(allConfigs)) {
      for (const pattern of config.mentionPatterns) {
        allPatterns.push({ pattern: pattern.toLowerCase(), catId: config.id });
      }
    }
    allPatterns.sort((a, b) => b.pattern.length - a.pattern.length); // longest first

    // 2-4. User-authored messages accept explicit @mentions anywhere in prose.
    // A2A/callback handoffs still use the stricter line-start parser in a2a-mentions.ts.
    const mentions: ParsedMention[] = [];
    const seenCats = new Set<string>();
    const routing_warnings: CatRoutingError[] = [];
    // Route-line grammar handles markdown/list wrappers before the broader inline scan.
    recordRouteLineMentions(lowerMessage, allPatterns, seenCats, mentions);

    // Explicit @mentions are user-authored route tokens and may appear anywhere in prose.
    forEachUserMentionCandidate(lowerMessage, (pos) => {
      const matched = findMentionPatternAt(lowerMessage, pos, allPatterns);
      if (matched) {
        recordResolvedMention(matched.catId, pos, seenCats, mentions);
        return;
      }
    });

    // Speech aliases like "at 砚砚" stay limited to route-line syntax; otherwise ordinary
    // prose such as "look at codex docs" would become an implicit route.
    if (speechRouteMessage !== lowerMessage) {
      recordRouteLineMentions(speechRouteMessage, allPatterns, seenCats, mentions);
    }

    mentions.sort((a, b) => a.position - b.position);
    return { mentions, routing_warnings };
  }

  private buildGroupMentionKeywordPatterns(): string[] {
    const keywords = ['@全体参与者', '@thread', '@本帖', '@全体', '@all'];
    for (const [breedId, info] of this.collectBreedGroups()) {
      keywords.push(`@全体${info.displayName}`, `@all-${breedId}`);
    }
    return keywords.map((keyword) => keyword.toLowerCase()).sort((a, b) => b.length - a.length);
  }

  private parseMentions(message: string): { mentions: CatId[]; routing_warnings: CatRoutingError[] } {
    const raw = this.parseMentionsRaw(message);
    return {
      mentions: raw.mentions.map((mention) => mention.catId),
      routing_warnings: raw.routing_warnings,
    };
  }

  private collectBreedGroups(): Map<string, { displayName: string; catIds: CatId[] }> {
    const breedMap = new Map<string, { displayName: string; catIds: CatId[] }>();
    for (const [catId, config] of Object.entries(catRegistry.getAllConfigs())) {
      if (!config.breedId || !Object.hasOwn(this.services, catId)) continue;
      const existing = breedMap.get(config.breedId);
      if (existing) {
        existing.catIds.push(catId as CatId);
      } else {
        breedMap.set(config.breedId, {
          displayName: config.breedDisplayName ?? config.displayName,
          catIds: [catId as CatId],
        });
      }
    }
    return breedMap;
  }

  /**
   * F078: Parse group mentions (@all, @全体, @全体{breed}, @all-{breed}, @thread, @本帖, @全体参与者).
   * Returns matched CatIds or null if no group mention found.
   * Called BEFORE individual parseMentions — group patterns are longer and take priority.
   *
   * P1 fix: uses token boundary check (same regex as parseMentions) to avoid
   * substring collisions like @allison→@all or @threadsafe→@thread.
   * User-authored group mentions share the individual mention scanner, so a
   * valid token works inline while quotes, code blocks, and URLs remain inert.
   */
  private async parseGroupMentions(
    message: string,
    threadId: string,
    options?: { allowFallback?: boolean },
  ): Promise<{ cats: CatId[]; matchPosition: number } | null> {
    const lowerMessage = this.normalizeSpeechMentions(message).toLowerCase();

    /** Find first boundary-valid match position, or -1 if not found */
    const findMatchPosition = (pattern: string): number => {
      const lowerPattern = pattern.toLowerCase();
      let found = -1;
      forEachUserMentionCandidate(lowerMessage, (candidate) => {
        if (found >= 0) return;
        const end = matchMentionPatternEnd(lowerMessage, candidate, lowerPattern);
        if (end !== null && isMentionEndBoundary(lowerMessage, end)) found = candidate;
      });
      return found;
    };

    // Build all group patterns sorted longest-first for correct priority
    interface GroupPattern {
      pattern: string;
      resolve: () => Promise<CatId[] | null>;
    }
    const patterns: GroupPattern[] = [];

    // Thread-scoped patterns
    for (const pattern of ['@全体参与者', '@thread', '@本帖']) {
      patterns.push({
        pattern,
        resolve: async () => {
          if (this.threadStore) {
            const participants = await this.threadStore.getParticipants(threadId);
            const valid = this.filterRoutableCats(participants);
            if (valid.length > 0) return valid as CatId[];
          }
          if (options?.allowFallback === false) return [];
          const fallback = this.pickFallbackCat(new Set());
          return fallback ? [fallback] : [];
        },
      });
    }

    // Breed-scoped patterns: @全体{displayName} and @all-{breedId}
    for (const [breedId, info] of this.collectBreedGroups()) {
      const catIds = info.catIds;
      patterns.push({ pattern: `@全体${info.displayName}`, resolve: async () => this.filterRoutableCats(catIds) });
      patterns.push({ pattern: `@all-${breedId}`, resolve: async () => this.filterRoutableCats(catIds) });
    }

    // Global @all / @全体 (shortest — must be last)
    patterns.push({
      pattern: '@全体',
      resolve: async () => {
        const allCats = this.filterRoutableCats(Object.keys(this.services));
        if (allCats.length > 0) return allCats;
        if (options?.allowFallback === false) return [];
        const fallback = this.pickFallbackCat(new Set());
        return fallback ? [fallback] : [];
      },
    });
    patterns.push({
      pattern: '@all',
      resolve: async () => {
        const allCats = this.filterRoutableCats(Object.keys(this.services));
        if (allCats.length > 0) return allCats;
        if (options?.allowFallback === false) return [];
        const fallback = this.pickFallbackCat(new Set());
        return fallback ? [fallback] : [];
      },
    });

    // Sort longest-first to avoid prefix collisions (@全体布偶猫 before @全体)
    patterns.sort((a, b) => b.pattern.length - a.pattern.length);

    for (const { pattern, resolve } of patterns) {
      const pos = findMatchPosition(pattern);
      if (pos >= 0) {
        const cats = await resolve();
        return cats ? { cats, matchPosition: pos } : null;
      }
    }

    return null;
  }

  /**
   * F078: Unified mention parser — group mentions + individual union.
   * F182: returns routing_warnings from individual parseMentions.
   *
   * Bug fix: previously group mentions short-circuited individual parsing,
   * so "@thread @gemini" would only dispatch to thread participants and drop
   * the explicit @gemini. Now we union both: group-expanded cats + any
   * explicit individual mentions not already in the group set.
   *
   * Order: respects mention position in original message. "@gemini @thread"
   * routes gemini first, then thread participants. "@thread @gemini" routes
   * thread participants first, then gemini.
   */
  private async parseAllMentions(
    message: string,
    threadId: string,
    options?: { allowGroupFallback?: boolean },
  ): Promise<{ mentions: CatId[]; routing_warnings: CatRoutingError[] }> {
    const groupResult = await this.parseGroupMentions(message, threadId, {
      allowFallback: options?.allowGroupFallback,
    });
    if (groupResult !== null) {
      // Position-aware union: merge individual mentions around group based on message position
      const individual = this.parseMentionsRaw(message);
      const groupPos = groupResult.matchPosition;
      const groupSet = new Set<string>(groupResult.cats.map(String));

      const before: CatId[] = [];
      const after: CatId[] = [];
      for (const m of individual.mentions) {
        if (groupSet.has(String(m.catId))) continue; // dedup: already in group expansion
        if (m.position < groupPos) {
          before.push(m.catId);
        } else {
          after.push(m.catId);
        }
      }

      return {
        mentions: [...before, ...groupResult.cats, ...after],
        routing_warnings: [],
      };
    }
    return this.parseMentions(message);
  }

  private applyRoutingPolicyForPreview(
    thread: { routingPolicy?: ThreadRoutingPolicyV1 } | null | undefined,
    message: string,
    candidates: CatId[],
    reasonKind: Exclude<RoutingPreviewReasonKind, 'thread_policy'>,
  ): RoutingPreviewResponse {
    const targetCats = this.applyThreadRoutingPolicy(thread, message, candidates);
    const unchanged =
      targetCats.length === candidates.length && targetCats.every((catId, index) => catId === candidates[index]);
    const reason: RoutingPreviewReason = unchanged
      ? { kind: reasonKind }
      : { kind: 'thread_policy', baseKind: reasonKind };
    return { targetCats, reason };
  }

  /**
   * One read-only resolver shared by the composer preview and the real send path.
   * A prospective preference represents a not-yet-created conversation: it has no
   * prior mentions or repliers and never writes a synthetic thread.
   */
  private async resolveTargetPreview(
    message: string,
    threadId: string,
    options?: { prospectivePreferredCats?: readonly CatId[]; publicConversation?: boolean },
  ): Promise<RoutingPreviewResponse> {
    const { mentions: mentionedCats } = await this.parseAllMentions(message, threadId, {
      allowGroupFallback: !options?.publicConversation,
    });
    // Common conversation admission can select an available recipient. Exact
    // callers retain named identities so an unavailable member reports its cause.
    const targets = options?.publicConversation ? this.filterRoutableCats(mentionedCats) : mentionedCats;
    if (targets.length > 0) {
      const unavailableTargets = options?.publicConversation
        ? this.filterKnownCats(mentionedCats).filter((id) => !this.isRoutableCat(id))
        : [];
      return {
        targetCats: targets,
        reason: { kind: 'current_message_mentions' },
        ...(unavailableTargets.length ? { unavailableTargets } : {}),
      };
    }
    const result = await this.resolveImplicitTargetPreview(message, threadId, options);
    const unavailableTargets = this.filterKnownCats(mentionedCats).filter((id) => !this.isRoutableCat(id));
    return unavailableTargets.length
      ? { ...result, unavailableTargets: [...new Set([...unavailableTargets, ...(result.unavailableTargets ?? [])])] }
      : result;
  }

  /** One policy owner for implicit preview, common send and queued public recovery. */
  private async resolveImplicitTargetPreview(
    message: string,
    threadId: string,
    options?: { prospectivePreferredCats?: readonly CatId[] },
  ): Promise<RoutingPreviewResponse> {
    const prospective = options?.prospectivePreferredCats !== undefined;
    if (!prospective && !this.threadStore) {
      // Preserve the pre-existing no-store fallback used by narrow tests and
      // compatibility callers; production routing always has a ThreadStore.
      return { targetCats: [getDefaultCatId()], reason: { kind: 'default_cat' } };
    }
    const thread:
      | {
          preferredCats?: readonly CatId[];
          routingPolicy?: ThreadRoutingPolicyV1;
          threadKind?: string;
        }
      | null
      | undefined = prospective
      ? { preferredCats: [...(options?.prospectivePreferredCats ?? [])] }
      : await this.threadStore?.get(threadId);
    const unavailableTargets: CatId[] = [];
    const project = (candidates: CatId[], kind: Exclude<RoutingPreviewReasonKind, 'thread_policy'>) => ({
      ...this.applyRoutingPolicyForPreview(thread, message, candidates, kind),
      ...(unavailableTargets.length ? { unavailableTargets: [...new Set(unavailableTargets)] } : {}),
    });
    const rawPref = Array.isArray(thread?.preferredCats) ? thread.preferredCats : [];
    const validPreferred = this.filterRoutableCats(rawPref);
    const preferredSet = new Set(validPreferred.map(String));

    // #58: explicit #ideate with multiple preferred cats → dispatch all.
    if (/#ideate\b/i.test(message) && validPreferred.length > 1) {
      return project(validPreferred, 'preferred_parallel');
    }

    // F229: a concierge duty cat overrides implicit history, while an explicit
    // mention in the current message still won above.
    if (!prospective && thread?.threadKind === 'concierge' && validPreferred.length > 0) {
      return project(validPreferred, 'concierge_preferred');
    }

    if (!prospective && this.threadStore) {
      const mentions = await findLastUserMentions(this.messageStore, threadId);
      for (const catId of this.filterKnownCats(mentions)) {
        if (this.isRoutableCat(catId)) return project([catId], 'previous_user_mentions');
        unavailableTargets.push(catId);
      }

      const participantsWithActivity = await this.threadStore.getParticipantsWithActivity(threadId);
      const isRoutable = (participant: { catId: CatId }) => this.isRoutableCat(participant.catId);
      const isHealthy = (participant: { lastResponseHealthy?: boolean }) => participant.lastResponseHealthy !== false;
      const healthyReplier = participantsWithActivity.find(
        (participant) => participant.messageCount > 0 && isHealthy(participant) && isRoutable(participant),
      );
      if (healthyReplier) {
        return project([healthyReplier.catId], 'recent_replier');
      }
      const preferredFallback = participantsWithActivity.find(
        (participant) =>
          isHealthy(participant) && isRoutable(participant) && preferredSet.has(participant.catId as string),
      );
      if (preferredFallback) {
        return project([preferredFallback.catId], 'preferred_cat');
      }
      const anyFallback = participantsWithActivity.find(
        (participant) => isHealthy(participant) && isRoutable(participant),
      );
      if (anyFallback) {
        return project([anyFallback.catId], 'available_participant');
      }
    }

    if (validPreferred.length > 0) {
      return project([validPreferred[0]], 'preferred_cat');
    }

    return project([getDefaultCatId()], 'default_cat');
  }

  /** Read-only projection for the v2 composer; never mutates participants. */
  async previewTargets(
    message: string,
    options: { threadId: string; prospectivePreferredCats?: readonly CatId[] },
  ): Promise<RoutingPreviewResponse> {
    return this.resolveTargetPreview(message, options.threadId, {
      publicConversation: true,
      ...(options.prospectivePreferredCats === undefined
        ? {}
        : { prospectivePreferredCats: options.prospectivePreferredCats }),
    });
  }

  /** Read-only target resolution used before route admission. */
  private async peekTargets(message: string, threadId: string): Promise<CatId[]> {
    return (await this.resolveTargetPreview(message, threadId)).targetCats;
  }

  /** Resolve target cats and persist only explicit mentions as thread participants. */
  private async resolveTargets(message: string, threadId: string): Promise<CatId[]> {
    const preview = await this.resolveTargetPreview(message, threadId);
    if (preview.reason.kind === 'current_message_mentions' && this.threadStore) {
      await this.threadStore.addParticipants(threadId, preview.targetCats);
    }
    return preview.targetCats;
  }

  /** Build shared strategy dependencies (public for ModeOrchestrator) */
  getStrategyDeps(): RouteStrategyDeps {
    const apiPort = process.env.API_SERVER_PORT ?? String(deploymentDefaults.apiPort);
    return {
      services: this.services,
      unavailableServices: this.unavailableServices,
      ...(this.routingDispatchPreflight ? { routingDispatchPreflight: this.routingDispatchPreflight } : {}),
      invocationDeps: {
        ...(this.resolveTrustedImagePath ? { resolveTrustedImagePath: this.resolveTrustedImagePath } : {}),
        messageStore: this.messageStore,
        registry: this.registry,
        sessionManager: this.sessionManager,
        threadStore: this.threadStore,
        apiUrl: `http://127.0.0.1:${apiPort}`,
        ...(this.turnExecutionStore ? { turnExecutionStore: this.turnExecutionStore } : {}),
        ...(this.taskProgressStore ? { taskProgressStore: this.taskProgressStore } : {}),
        ...(this.sessionChainStore ? { sessionChainStore: this.sessionChainStore } : {}),
        ...(this.contextEpochOwner ? { contextEpochOwner: this.contextEpochOwner } : {}),
        hookAuthenticationReady: this.hookAuthenticationReady,
        claudeProjectHookCarrierReady: this.claudeProjectHookCarrierReady,
        ...(this.claudeCompactionHooks ? { claudeCompactionHooks: this.claudeCompactionHooks } : {}),
        ...(this.presentationLedger ? { presentationLedger: this.presentationLedger } : {}),
        ...(this.routingContextPromptProjection
          ? { routingContextPromptProjection: this.routingContextPromptProjection }
          : {}),
        ...(this.routingDispatchSignalObserver
          ? { routingDispatchSignalObserver: this.routingDispatchSignalObserver }
          : {}),
        ...(this.writeOpportunityTerminalLedger
          ? { writeOpportunityTerminalLedger: this.writeOpportunityTerminalLedger }
          : {}),
        ...(this.writeOpportunityDeliveryStore
          ? { writeOpportunityDeliveryStore: this.writeOpportunityDeliveryStore }
          : {}),
        ...(this.runtimeSessionStore ? { runtimeSessionStore: this.runtimeSessionStore } : {}),
        ...(this.transcriptWriter ? { transcriptWriter: this.transcriptWriter } : {}),
        ...(this.transcriptReader ? { transcriptReader: this.transcriptReader } : {}),
        ...(this.sessionSealer ? { sessionSealer: this.sessionSealer } : {}),
        ...(this.taskStore ? { taskStore: this.taskStore } : {}),
        ...(this.workflowSopStore ? { workflowSopStore: this.workflowSopStore } : {}),
        ...(this.executionDigestStore ? { executionDigestStore: this.executionDigestStore } : {}),
        ...(this.tmuxGateway ? { tmuxGateway: this.tmuxGateway } : {}),
        ...(this.agentPaneRegistry ? { agentPaneRegistry: this.agentPaneRegistry } : {}),
        ...(this.guideSessionStore ? { guideSessionStore: this.guideSessionStore } : {}),
        ...(this.dismissTracker ? { dismissTracker: this.dismissTracker } : {}),
        ...(this.conciergeConfigStore ? { conciergeConfigStore: this.conciergeConfigStore } : {}),
        ...(this.conciergeTriagePlanStore ? { conciergeTriagePlanStore: this.conciergeTriagePlanStore } : {}),
        ...(this.cloudInvokeBridge ? { cloudInvokeBridge: this.cloudInvokeBridge } : {}),
        ...(this.cloudReturnGrantStore ? { cloudReturnGrantStore: this.cloudReturnGrantStore } : {}),
        ...(this.freshnessStateStore ? { freshnessStateStore: this.freshnessStateStore } : {}),
        ...(this.runtimeInteractionPort ? { runtimeInteractionPort: this.runtimeInteractionPort } : {}),
        ...(this.memoryCuePromptService ? { memoryCuePromptService: this.memoryCuePromptService } : {}),
        ...(this.profileCueOpportunitySource ? { profileCueOpportunitySource: this.profileCueOpportunitySource } : {}),
        ...(this.threadOverviewOpportunitySource
          ? { threadOverviewOpportunitySource: this.threadOverviewOpportunitySource }
          : {}),
        ...(this.eventCueOpportunitySource ? { eventCueOpportunitySource: this.eventCueOpportunitySource } : {}),
        ...(this.profileRepository ? { profileRepository: this.profileRepository } : {}),
      },
      messageStore: this.messageStore,
      ...(this.dotReplyTarget ? { dotReplyTarget: this.dotReplyTarget } : {}),
      deliveryCursorStore: this.deliveryCursorStore,
      ...(this.taskStore ? { taskStore: this.taskStore } : {}),
      ...(this.threadExecutionSituationSource
        ? { threadExecutionSituationSource: this.threadExecutionSituationSource }
        : {}),
      ...(this.draftStore ? { draftStore: this.draftStore } : {}),
      ...(this.socketManager ? { socketManager: this.socketManager } : {}),
      ...(this.packStore ? { packStore: this.packStore } : {}),
      ...(this.evidenceStore ? { evidenceStore: this.evidenceStore } : {}),
      ...(this.proactiveMemoryNudgeService ? { proactiveMemoryNudgeService: this.proactiveMemoryNudgeService } : {}),
      ...(this.humanDispositionFeedbackContextService
        ? { humanDispositionFeedbackContextService: this.humanDispositionFeedbackContextService }
        : {}),
      ...(this.toolUsageCounter ? { toolUsageCounter: this.toolUsageCounter } : {}),
      ...(this.toolEventLog ? { toolEventLog: this.toolEventLog } : {}),
      ...(this.skillLoadEventLog ? { skillLoadEventLog: this.skillLoadEventLog } : {}),
      ...(this.worldContextProvider ? { worldContextProvider: this.worldContextProvider } : {}),
      ...(this.worldStore ? { worldStore: this.worldStore } : {}),
      ...(this.frustrationIssueStore ? { frustrationIssueStore: this.frustrationIssueStore } : {}),
      ...(this.ballCustody ? { ballCustody: this.ballCustody } : {}),
      ...(this.turnCustodyProjectionService ? { turnCustodyProjectionService: this.turnCustodyProjectionService } : {}),
      ...(this.freshnessEventLog ? { freshnessEventLog: this.freshnessEventLog } : {}),
      ...(this.freshnessOutputCommitCoordinator
        ? { freshnessOutputCommitCoordinator: this.freshnessOutputCommitCoordinator }
        : {}),
      ...(this.injectionTraceStore ? { injectionTraceStore: this.injectionTraceStore } : {}),
      ...(this.personMemoryProposalStatusContextResolver
        ? { personMemoryProposalStatusContextResolver: this.personMemoryProposalStatusContextResolver }
        : {}),
    };
  }

  /**
   * Resolve targets and intent.
   * Default: read-only peek (safe to call before route()).
   * With persist: true, also writes @mentions to thread participants.
   */
  async resolveTargetsAndIntent(
    message: string,
    threadId?: string,
    options?: { persist?: boolean; allowFallback?: boolean },
  ): Promise<{
    targetCats: CatId[];
    intent: IntentResult;
    hasMentions: boolean;
    routing_warnings: CatRoutingError[];
  }> {
    const resolvedThreadId = threadId ?? DEFAULT_THREAD_ID;
    // Only registered mention patterns select members. Unmatched @ text is ordinary prose.
    const allMentions = await this.parseAllMentions(message, resolvedThreadId, {
      allowGroupFallback: options?.allowFallback !== false,
    });
    const hasMentions = allMentions.mentions.length > 0;
    const routing_warnings = allMentions.routing_warnings;
    let targetCats: CatId[];
    if (options?.allowFallback === false) {
      targetCats = allMentions.mentions;
      if (options.persist && targetCats.length > 0 && this.threadStore) {
        await this.threadStore.addParticipants(resolvedThreadId, targetCats);
      }
    } else {
      targetCats = options?.persist
        ? await this.resolveTargets(message, resolvedThreadId)
        : await this.peekTargets(message, resolvedThreadId);
    }
    const intent = parseIntent(message, targetCats.length);
    return { targetCats, intent, hasMentions, routing_warnings };
  }

  /**
   * Route message to appropriate agent(s) based on @ mentions and thread participants.
   * @deprecated Use routeExecution() instead — route() couples message writing with execution.
   *             Will be removed after S4 migration is complete.
   */
  async *route(
    userId: string,
    message: string,
    threadId?: string,
    contentBlocks?: readonly MessageContent[],
    uploadDir?: string,
    signal?: AbortSignal,
    a2aOptions?: Pick<RouteOptions, 'ownerAuthProvenance'>,
  ): AsyncIterable<AgentMessage> {
    const resolvedThreadId = threadId ?? DEFAULT_THREAD_ID;
    const { targetCats, intent } = await this.resolveTargetsAndIntent(message, resolvedThreadId, {
      persist: true,
    });
    const strategy = intent.intent === 'ideate' && targetCats.length > 1 ? 'parallel' : 'serial';
    const cleanMessage = appendContextAttachmentsToPrompt(stripIntentTags(message), contentBlocks);

    const routeSpan = routeTracer.startSpan('cat_cafe.route', {
      attributes: {
        [ROUTING_TARGET_CATS]: (targetCats as string[]).join(','),
        [ROUTING_INTENT]: intent.intent,
        [ROUTING_STRATEGY]: strategy,
      },
    });

    // Fetch the legacy thinkingMode used for same-turn multi-cat response isolation.
    let legacyThinkingMode: 'debug' | 'play' = 'play';
    if (this.threadStore) {
      const thread = await this.threadStore.get(resolvedThreadId);
      if (thread) {
        legacyThinkingMode = thread.thinkingMode ?? 'play';
      }
      await this.threadStore.updateLastActive(resolvedThreadId);
    }

    const storedUserMessage = await this.messageStore.append({
      from: { kind: 'user', userId },
      userId,
      content: message, // Store original (with tags) for audit
      mentions: targetCats,
      timestamp: Date.now(),
      threadId: resolvedThreadId,
      ...(contentBlocks ? { contentBlocks } : {}),
    });

    const strategyDeps = this.getStrategyDeps();
    const routingContextIntent = inferRoutingContextIntent(cleanMessage);
    const routeOptions = {
      routeIntent: projectAgentRouteIntent(intent),
      ...(routingContextIntent ? { routingContextIntent } : {}),
      contentBlocks,
      uploadDir,
      signal,
      promptTags: intent.promptTags,
      currentUserMessageId: storedUserMessage.id,
      thinkingMode: legacyThinkingMode,
      routeSpan,
      ...a2aOptions,
    };

    try {
      if (strategy === 'parallel') {
        yield* routeParallel(strategyDeps, targetCats, cleanMessage, userId, resolvedThreadId, routeOptions);
      } else {
        yield* routeSerial(strategyDeps, targetCats, cleanMessage, userId, resolvedThreadId, routeOptions);
      }
      routeSpan.setStatus({ code: SpanStatusCode.OK });
    } catch (err) {
      routeSpan.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
      throw err;
    } finally {
      routeSpan.end();
    }
  }

  /**
   * Execute cat invocation without writing the user message (ADR-008 S1).
   * Message writing is decoupled — the caller writes the message and passes its ID.
   *
   * @param userMessageId - ID of the already-stored user message
   * @param targetCats - pre-resolved target cats (from resolveTargets)
   * @param intent - pre-parsed intent result
   */
  async *routeExecution(
    userId: string,
    message: string,
    threadId: string,
    userMessageId: string,
    targetCats: CatId[],
    intent: IntentResult,
    options: RouteExecutionOptions,
  ): AsyncIterable<AgentMessage> {
    const cleanMessage = appendContextAttachmentsToPrompt(stripIntentTags(message), options.contentBlocks);
    const strategy =
      options.targetDispatchMode ?? (intent.intent === 'ideate' && targetCats.length > 1 ? 'parallel' : 'serial');

    // F153: Reconstruct remote parent context for cross-route A2A trace propagation
    const parentCtx = options?.callerTraceContext
      ? trace.setSpanContext(ctxApi.active(), {
          traceId: options.callerTraceContext.traceId,
          spanId: options.callerTraceContext.spanId,
          traceFlags: options.callerTraceContext.traceFlags,
          isRemote: true,
        })
      : undefined;

    const routeSpan = routeTracer.startSpan(
      'cat_cafe.route',
      {
        attributes: {
          [ROUTING_TARGET_CATS]: (targetCats as string[]).join(','),
          [ROUTING_INTENT]: intent.intent,
          [ROUTING_STRATEGY]: strategy,
          ...(options?.parentInvocationId ? { invocationId: options.parentInvocationId } : {}),
        },
      },
      parentCtx,
    );

    // Fetch thinkingMode for same-turn multi-cat response isolation + update lastActive.
    let thinkingMode: 'debug' | 'play' = 'play';
    if (this.threadStore) {
      const thread = await this.threadStore.get(threadId);
      if (thread) {
        thinkingMode = thread.thinkingMode ?? 'play';
      }
      await this.threadStore.updateLastActive(threadId);
    }

    const strategyDeps = this.getStrategyDeps();
    const routingContextIntent = inferRoutingContextIntent(cleanMessage);
    const { callerTraceContext: _callerTraceContext, ...strategyInputOptions } = options;
    const routeOptions: RouteOptions = {
      ...strategyInputOptions,
      routeIntent: projectAgentRouteIntent(intent),
      ...(routingContextIntent ? { routingContextIntent } : {}),
      promptTags: intent.promptTags,
      currentUserMessageId: userMessageId,
      persistedPromptMessages: options?.persistedPromptMessages?.map((persisted) => ({
        ...persisted,
        content: stripIntentTags(persisted.content),
      })),
      thinkingMode,
      routeSpan,
    };

    try {
      if (strategy === 'parallel') {
        yield* routeParallel(strategyDeps, targetCats, cleanMessage, userId, threadId, routeOptions);
      } else {
        yield* routeSerial(strategyDeps, targetCats, cleanMessage, userId, threadId, routeOptions);
      }
      routeSpan.setStatus({ code: SpanStatusCode.OK });
    } catch (err) {
      routeSpan.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
      throw err;
    } finally {
      // F153 Phase F KD-22: Write route span tracing to user message for cold start recovery.
      // Runs in finally so both success and error paths persist the route root pointer.
      if (userMessageId && !options?.requiresExactCloudDispatchProvenance) {
        const sc = routeSpan.spanContext();
        try {
          await Promise.resolve(
            this.messageStore.updateExtra(userMessageId, { tracing: { traceId: sc.traceId, spanId: sc.spanId } }),
          );
        } catch (backfillErr) {
          log.warn({ userMessageId, err: backfillErr }, 'Failed to write route tracing to user message');
        }
      }
      routeSpan.end();
    }
  }

  /**
   * ADR-008 S3: Ack all cursor boundaries collected during execution.
   * Called after succeeded, and also on abort/exception for already-completed cats.
   */
  async ackCollectedCursors(userId: string, threadId: string, boundaries: Map<string, string>): Promise<void> {
    for (const [catId, boundaryId] of boundaries) {
      try {
        await this.deliveryCursorStore.ackCursor(userId, catId as CatId, threadId, boundaryId);
        log.info(
          {
            f148: 'delivery-cursor-ack',
            threadId,
            catId,
            boundaryRef: boundaryId,
            writer: 'AgentRouter.ackCollectedCursors',
          },
          '[F153] content-free delivery cursor writer audit',
        );
      } catch (err) {
        log.error({ catId, err }, `[ackCollectedCursors] failed`);
      }
    }
  }
}
