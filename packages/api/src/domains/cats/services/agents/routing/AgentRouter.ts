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
import { catRegistry, escapeRegExp } from '@cat-cafe/shared';
import type { SessionStore } from '@cat-cafe/shared/utils';
import { context as ctxApi, SpanStatusCode, trace } from '@opentelemetry/api';
import { getDefaultCatId, isCatAvailable } from '../../../../../config/cat-config-loader.js';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import type { CallerTraceContext } from '../../../../../infrastructure/telemetry/genai-semconv.js';
import {
  ROUTING_INTENT,
  ROUTING_STRATEGY,
  ROUTING_TARGET_CATS,
} from '../../../../../infrastructure/telemetry/genai-semconv.js';
import type { IntentResult } from '../../context/IntentParser.js';
import { parseIntent, ROUTE_CONTROL_TAGS, stripIntentTags } from '../../context/IntentParser.js';
import type { IRuntimeSessionStore } from '../../runtime-session/RuntimeSessionStore.js';
import { SessionManager } from '../../session/SessionManager.js';
import type { ISessionSealer } from '../../session/SessionSealer.js';
import type { TranscriptReader } from '../../session/TranscriptReader.js';
import type { TranscriptWriter } from '../../session/TranscriptWriter.js';
import { DeliveryCursorStore } from '../../stores/ports/DeliveryCursorStore.js';
import type { IDraftStore } from '../../stores/ports/DraftStore.js';
import type { IMessageStore } from '../../stores/ports/MessageStore.js';
import type { ISessionChainStore } from '../../stores/ports/SessionChainStore.js';
import type { ITaskStore } from '../../stores/ports/TaskStore.js';
import type { IThreadStore, ThreadRoutingPolicyV1, ThreadRoutingScope } from '../../stores/ports/ThreadStore.js';
import { DEFAULT_THREAD_ID } from '../../stores/ports/ThreadStore.js';
import type { IWorkflowSopStore } from '../../stores/ports/WorkflowSopStore.js';
import { SYSTEM_USER_IDS } from '../../stores/visibility.js';
import type { AgentMessage, AgentService } from '../../types.js';
import type { InvocationRegistry } from '../invocation/InvocationRegistry.js';
import type { TaskProgressStore } from '../invocation/TaskProgressStore.js';
import type { AgentRegistry } from '../registry/AgentRegistry.js';
import type { PersistenceContext, RouteOptions, RouteStrategyDeps } from '../routing/route-helpers.js';
import { routeParallel } from '../routing/route-parallel.js';
import { routeSerial } from '../routing/route-serial.js';
import { resolveCatTarget } from './cat-target-resolver.js';

const log = createModuleLogger('agent-router');
const routeTracer = trace.getTracer('cat-cafe-api', '0.1.0');

/**
 * F194 Phase Z5 AC-Z16: 无 @ fallback 回看最近 thread messages 找上一条 user message
 * 的 mentions。
 *
 * Spec 窗口 = N=5 USER messages OR 时间窗口 1h（防远古 mentions 主导 fallback）。
 *
 * 实现 = 以 USER message 为停止条件分页扫 thread messages（不是固定 thread message
 * 窗口）：cat-to-cat handoff / vision guard / cross-post 等 cat 消息不消耗 user count
 * 也不能挤掉远一点的 user mention。
 *
 * 砚砚 review 历程：
 *   R1 P1：原实现 `getByThread(threadId, 5)` 取最近 5 条 thread messages，user @ 后
 *     只要 5 条 cat/vision-guard 就把 user mention 挤出窗口 → Bug D 复活。
 *   R2 P1：R2 改成 `getByThread(threadId, 50)` + 反向数 N=5 user msgs + 1h cutoff，
 *     但仍然是单页 thread window — 51+ 条 cat 消息夹中间就退化回原 bug。
 *   R3 P1（当前）：改成分页 loop（getByThread 拉首页 → 不够再 getByThreadBefore
 *     拿历史页），停在 N=5 USER msgs / 1h cutoff / 没有更多消息。
 *     defensive 上限 = Z5_PAGE_SIZE * Z5_MAX_PAGES = 250 条 thread messages。
 */
const Z5_PAGE_SIZE = 50;
const Z5_USER_MESSAGE_COUNT_LIMIT = 5;
const Z5_TIME_WINDOW_MS = 60 * 60 * 1000; // 1h
const MENTION_TOKEN_BOUNDARY_RE = /[\s,.:;!?()[\]{}<>，。！？、：；（）【】《》「」『』〈〉]/;
const HANDLE_CONTINUATION_RE = /[a-z0-9_.-]/;
const QUOTE_BEFORE_MENTION_RE = /["'“”‘’]/;
const DOMAIN_SUFFIX_START_RE = /[\p{L}\p{N}]/u;
const BARE_URL_PREFIX_BEFORE_MENTION_RE = /(?:^|[^a-z0-9_-])(?:[a-z0-9-]+\.)+[a-z0-9-]+(?:\/[^\s@]*)*\/$/i;
const DOMAIN_LIKE_UNKNOWN_HANDLE_RE = /^[a-z0-9_-]+(?:\.[a-z0-9-]+)+$/i;
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

function getRouteLineStart(line: string): number | null {
  let cursor = line.match(LINE_START_MENTION_PREFIX_RE)?.[0].length ?? 0;

  while (true) {
    while (line[cursor] === ' ' || line[cursor] === '\t') cursor++;
    const tag = line.slice(cursor).match(ROUTE_CONTROL_TAG_RE)?.[0];
    if (!tag) break;
    cursor += tag.length;
  }

  while (line[cursor] === ' ' || line[cursor] === '\t') cursor++;
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
): MentionPattern | null {
  for (const entry of patterns) {
    if (!message.startsWith(entry.pattern, pos)) continue;
    if (!isMentionEndBoundary(message, pos + entry.pattern.length)) continue;
    return entry;
  }
  return null;
}

function hasDomainSuffixedMentionPatternAt(message: string, pos: number, patterns: readonly MentionPattern[]): boolean {
  return patterns.some((entry) => {
    if (!message.startsWith(entry.pattern, pos)) return false;
    const suffixStart = pos + entry.pattern.length;
    const suffixNext = message[suffixStart + 1];
    return message[suffixStart] === '.' && suffixNext !== undefined && DOMAIN_SUFFIX_START_RE.test(suffixNext);
  });
}

function recordRouteLineMentions(
  message: string,
  patterns: readonly MentionPattern[],
  seenCats: Set<string>,
  mentions: ParsedMention[],
  routingWarnings: CatRoutingError[],
): void {
  const excluded = buildMentionExclusionSpans(message);
  forEachRouteLineMentionCandidate(message, (_line, lineOffset, candidate) => {
    const position = lineOffset + candidate;
    if (isInsideSpan(position, excluded)) return;
    const matched = findMentionPatternAt(message, position, patterns);
    if (matched) recordResolvedMention(matched.catId, position, seenCats, mentions, routingWarnings);
  });
}

function recordResolvedMention(
  catId: CatId,
  position: number,
  seenCats: Set<string>,
  mentions: ParsedMention[],
  routingWarnings: CatRoutingError[],
): void {
  const key = catId as string;
  const resolved = resolveCatTarget(key);
  if ('error' in resolved) {
    if (!seenCats.has(key)) {
      seenCats.add(key);
      routingWarnings.push(resolved.error);
    }
    return;
  }

  if (!seenCats.has(key)) {
    seenCats.add(key);
    mentions.push({ catId, position });
  }
}

function recordUnknownMentionWarning(
  message: string,
  position: number,
  seenCats: Set<string>,
  routingWarnings: CatRoutingError[],
): void {
  const handle = message.slice(position + 1).match(/^([a-z0-9_.-]+)/)?.[1];
  if (!handle) return;
  if (DOMAIN_LIKE_UNKNOWN_HANDLE_RE.test(handle)) return;
  const key = `@unknown:${handle}`;
  const resolved = resolveCatTarget(handle);
  if ('error' in resolved && !seenCats.has(key)) {
    seenCats.add(key);
    routingWarnings.push(resolved.error);
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
 * F042: Infer routing scope from message text (v1).
 * Intentionally deterministic and conservative.
 */
function inferRoutingScope(message: string): ThreadRoutingScope | null {
  const lower = message.toLowerCase();
  const hasPrToken = /\bpr\b/i.test(lower);

  // Review-ish cues
  if (
    lower.includes('review') ||
    lower.includes('lgtm') ||
    lower.includes('merge') ||
    hasPrToken ||
    message.includes('合入') ||
    message.includes('开 PR') ||
    message.includes('云端 review') ||
    message.includes('帮我看看') ||
    message.includes('请 reviewer 看看') ||
    message.includes('请 review')
  ) {
    return 'review';
  }

  // Architecture-ish cues
  if (
    lower.includes('architecture') ||
    lower.includes('tradeoff') ||
    message.includes('架构') ||
    message.includes('设计') ||
    message.includes('方案')
  ) {
    return 'architecture';
  }

  return null;
}

/**
 * Options for AgentRouter constructor
 */
export interface AgentRouterOptions {
  agentRegistry: AgentRegistry;
  registry: InvocationRegistry;
  messageStore: IMessageStore;
  /** F045 Gap #4: Redis-backed task progress snapshots */
  taskProgressStore?: TaskProgressStore;
  sessionStore?: SessionStore;
  deliveryCursorStore?: DeliveryCursorStore;
  threadStore?: IThreadStore;
  /** F24: Session chain store for context health tracking */
  sessionChainStore?: ISessionChainStore;
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
  /** F091: Signal article lookup for thread context injection */
  signalArticleLookup?: (threadId: string) => Promise<
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
  /** F129: Pack store for loading active packs at invocation time */
  packStore?: import('../../../../packs/PackStore.js').PackStore;
  /** F148: Evidence store for hierarchical context recall */
  evidenceStore?: import('../../../../memory/interfaces.js').IEvidenceStore;
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
  /** F222: Frustration auto-issue store */
  frustrationIssueStore?: import('../../stores/ports/FrustrationIssueStore.js').IFrustrationIssueStore;
  /** F222: Pending request store — cancel burst detection */
  pendingRequestStore?: import('../../stores/ports/PendingRequestStore.js').IPendingRequestStore;
  /** F229: Concierge config store for duty-cat岗位 prompt injection */
  conciergeConfigStore?: import('../../../../concierge/ConciergeConfigStore.js').IConciergeConfigStore;
  /** F229 KD-17: HandleMap store for concierge R1/R2→anchor mapping */
  conciergeHandleMapStore?: import('../../../../concierge/ConciergeHandleMapStore.js').IConciergeHandleMapStore;
  /** F229 Phase B: TriagePlan store for triage-plan marker → confirm/cancel card actions */
  conciergeTriagePlanStore?: import('../../../../concierge/ConciergeTriagePlanStore.js').IConciergeTriagePlanStore;
}

/**
 * Router that parses @ mentions and routes to appropriate agent services
 */
export class AgentRouter {
  private services: Record<string, AgentService>;
  private registry: InvocationRegistry;
  private messageStore: IMessageStore;
  private sessionManager: SessionManager;
  private deliveryCursorStore: DeliveryCursorStore;
  private threadStore: IThreadStore | null;
  private sessionChainStore: ISessionChainStore | undefined;
  private runtimeSessionStore: IRuntimeSessionStore | undefined;
  private transcriptWriter: TranscriptWriter | undefined;
  private transcriptReader: TranscriptReader | undefined;
  private sessionSealer: ISessionSealer | undefined;
  private draftStore: IDraftStore | undefined;
  private taskProgressStore: TaskProgressStore | undefined;
  private taskStore: ITaskStore | undefined;
  private workflowSopStore: IWorkflowSopStore | undefined;
  private executionDigestStore:
    | import('../../../../projects/execution-digest-store.js').ExecutionDigestStore
    | undefined;
  private socketManager: import('../../../../../infrastructure/websocket/SocketManager.js').SocketManager | undefined;
  private tmuxGateway: import('../../../../terminal/tmux-gateway.js').TmuxGateway | undefined;
  private agentPaneRegistry: import('../../../../terminal/agent-pane-registry.js').AgentPaneRegistry | undefined;
  private signalArticleLookup?:
    | ((threadId: string) => Promise<
        readonly {
          id: string;
          title: string;
          source: string;
          tier: number;
          contentSnippet: string;
          note?: string | undefined;
        }[]
      >)
    | undefined;
  private packStore?: import('../../../../packs/PackStore.js').PackStore;
  private evidenceStore?: import('../../../../memory/interfaces.js').IEvidenceStore;
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
  /** F222 */
  private frustrationIssueStore?: import('../../stores/ports/FrustrationIssueStore.js').IFrustrationIssueStore;
  private pendingRequestStore?: import('../../stores/ports/PendingRequestStore.js').IPendingRequestStore;
  /** F229 */
  private conciergeConfigStore?: import('../../../../concierge/ConciergeConfigStore.js').IConciergeConfigStore;
  /** F229 KD-17 */
  private conciergeHandleMapStore?: import('../../../../concierge/ConciergeHandleMapStore.js').IConciergeHandleMapStore;
  /** F229 Phase B */
  private conciergeTriagePlanStore?: import('../../../../concierge/ConciergeTriagePlanStore.js').IConciergeTriagePlanStore;
  private speechMentionRe: RegExp;

  /**
   * F222 Phase B: Collect the most recent TEXT_FRUSTRATION_WINDOW user messages
   * from a thread using Z5-style reverse-iterate paging, then run keyword detection.
   * Shared by both route() and routeExecution() (cloud P1 fix).
   *
   * Uses SYSTEM_USER_IDS (not just 'system') to exclude scheduler/connector noise (cloud P2 fix).
   */
  private async collectAndDetectTextFrustration(
    threadId: string,
    detectTextFrustration: (msgs: string[]) => { matched: boolean; matchedKeywords: string[]; matchCount: number },
  ): Promise<{ matched: boolean; matchedKeywords: string[]; matchCount: number; recentUserMessages: string[] }> {
    const { TEXT_FRUSTRATION_WINDOW } = await import('../../frustration/text-frustration-keywords.js');
    const PAGE_SIZE = 50;
    const MAX_PAGES = 10;
    const userMsgs: string[] = [];
    type MsgLike = {
      catId?: string | null;
      userId?: string;
      content?: string;
      id?: string;
      timestamp?: number;
      deliveredAt?: number;
    };
    let cursorScore = Infinity;
    let cursorId: string | undefined;
    let isFirstPage = true;
    for (let page = 0; page < MAX_PAGES && userMsgs.length < TEXT_FRUSTRATION_WINDOW; page++) {
      const batch: MsgLike[] = isFirstPage
        ? ((await this.messageStore.getByThread(threadId, PAGE_SIZE)) as MsgLike[])
        : ((await this.messageStore.getByThreadBefore(threadId, cursorScore, PAGE_SIZE, cursorId)) as MsgLike[]);
      isFirstPage = false;
      if (batch.length === 0) break;
      const first = batch[0]!;
      const dAt = typeof first.deliveredAt === 'number' ? first.deliveredAt : 0;
      const ts = typeof first.timestamp === 'number' ? first.timestamp : 0;
      const firstScore = dAt > 0 ? dAt : ts;
      if (firstScore > 0 && firstScore < cursorScore) {
        cursorScore = firstScore;
        cursorId = first.id;
      }
      for (let i = batch.length - 1; i >= 0 && userMsgs.length < TEXT_FRUSTRATION_WINDOW; i--) {
        const m = batch[i]!;
        // Cloud P2 fix: exclude all system users (scheduler, system, etc.), not just 'system'
        if (!m.catId && !SYSTEM_USER_IDS.has(m.userId ?? '')) {
          userMsgs.push(typeof m.content === 'string' ? m.content : '');
        }
      }
    }
    const detection = detectTextFrustration(userMsgs);
    return {
      ...detection,
      recentUserMessages: userMsgs.slice(0, 3).map((m) => m.slice(0, 200)),
    };
  }

  private rebuildRuntimeCaches(agentRegistry: AgentRegistry): void {
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
    this.sessionManager = new SessionManager(options.sessionStore);
    this.deliveryCursorStore = options.deliveryCursorStore ?? new DeliveryCursorStore(options.sessionStore);
    this.threadStore = options.threadStore ?? null;
    this.sessionChainStore = options.sessionChainStore;
    this.runtimeSessionStore = options.runtimeSessionStore;
    this.transcriptWriter = options.transcriptWriter;
    this.transcriptReader = options.transcriptReader;
    this.sessionSealer = options.sessionSealer;
    this.draftStore = options.draftStore;
    this.taskProgressStore = options.taskProgressStore;
    this.taskStore = options.taskStore;
    this.workflowSopStore = options.workflowSopStore;
    this.executionDigestStore = options.executionDigestStore;
    this.socketManager = options.socketManager;
    this.tmuxGateway = options.tmuxGateway;
    this.agentPaneRegistry = options.agentPaneRegistry;
    this.signalArticleLookup = options.signalArticleLookup;
    this.packStore = options.packStore;
    this.evidenceStore = options.evidenceStore;
    this.toolUsageCounter = options.toolUsageCounter;
    this.toolEventLog = options.toolEventLog;
    this.skillLoadEventLog = options.skillLoadEventLog;
    this.guideSessionStore = options.guideSessionStore;
    this.dismissTracker = options.dismissTracker;
    this.worldContextProvider = options.worldContextProvider;
    this.worldStore = options.worldStore;
    this.ballCustody = options.ballCustody;
    this.frustrationIssueStore = options.frustrationIssueStore;
    this.pendingRequestStore = options.pendingRequestStore;
    this.conciergeConfigStore = options.conciergeConfigStore;
    this.conciergeHandleMapStore = options.conciergeHandleMapStore;
    this.conciergeTriagePlanStore = options.conciergeTriagePlanStore;
  }

  refreshFromRegistry(agentRegistry: AgentRegistry): void {
    this.rebuildRuntimeCaches(agentRegistry);
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

  /**
   * F194 Phase Z5 AC-Z16: 无 @ fallback 优先用上一条 user message 的 mentions，
   * 不让 thread 里其他猫的发言（如 vision guard cross-post）抢路由 fallback。
   *
   * 用户心智模型："no @ = 继续刚才 @ 的猫里的一只"，不是"thread 里最近发言的猫"，
   * 也不是把上一轮 parallel mentions 全量延续成新一轮并发。
   *
   * user message 严格定义：`userId !== null && catId === null`。
   *   - cat-to-cat handoff (A2A) 有 catId → NOT a user message
   *   - vision guard cross-post 有 catId → NOT a user message
   *   - 系统消息 (userId === null && catId === null) → NOT a user message
   *
   * 时间窗口：回看最近 N=5 条 user messages，防止远古 mentions 主导 fallback。
   * 在 N 条窗口内找到的最近一条 user message 后，取第一个 routable mention
   * 作为 deterministic single-cat fallback。
   */
  private async findRecentUserMentionFallback(threadId: string): Promise<CatId[] | null> {
    if (!this.messageStore) return null;
    // F194 Phase Z5 R2 (砚砚 R1 P1#1): MessageStore interface 允许 sync 数组 OR async Promise
    // (memory mock 是同步，Redis 生产是 async)。必须 await 才能拿到 Redis 实际数据。
    // F194 Phase Z5 R4 (砚砚 R3 P1): 改为分页扫 — 以 USER message 数 / 时间窗口为
    // 停止条件，而不是固定 thread message 窗口。
    //   首页 = getByThread(threadId, PAGE_SIZE) — 最近 PAGE_SIZE 条 (ascending by score)
    //   历史页 = getByThreadBefore(threadId, oldest.score, PAGE_SIZE, oldest.id) — 再往前
    //   每页内反向扫，遇 user msg 计 user count，遇有 mentions 直接 return。
    // F194 Phase Z5 R10 (cloud Codex round-6 P2): 去掉固定 page cap，仅靠 spec stop conditions
    //   (5 user msgs / 1h cutoff / no more history) 收敛。固定 page cap 在高流量 thread
    //   (vision-guard / handoff > 250) 仍可能漏掉真正的 user @ → 退化回 participantsWithActivity。
    //   1h cutoff 通过 effective score 时间维度天然 bound 扫描深度（cat msg score 最终 < cutoff
    //   时整页都比 cutoff 老，user msg cutoff 触发 return null），不会无限循环。
    // F194 Phase Z5 R9 (砚砚 R8 P1): cursor + cutoff 都用 effectiveOrderTime = deliveredAt ?? timestamp
    //   (与 Redis thread zset score 同口径)。markDelivered 把 score 改成 deliveredAt 但
    //   msg.timestamp 仍是 send-time，如果 cursor 用 timestamp 跳到老 send-time → 跨页跳过中间
    //   deliveredAt 排序的页面 → 真正的 user mention 在那段被漏。
    const effectiveOrderTime = (m: { timestamp?: unknown; deliveredAt?: unknown }): number => {
      const delivered = typeof m?.deliveredAt === 'number' ? m.deliveredAt : 0;
      const ts = typeof m?.timestamp === 'number' ? m.timestamp : 0;
      return delivered > 0 ? delivered : ts;
    };
    const cutoffTimestamp = Date.now() - Z5_TIME_WINDOW_MS;
    let userMessagesSeen = 0;
    let cursorScore: number | undefined;
    let cursorId: string | undefined;

    for (let pageIdx = 0; ; pageIdx += 1) {
      const pageResult =
        pageIdx === 0
          ? this.messageStore.getByThread(threadId, Z5_PAGE_SIZE)
          : this.messageStore.getByThreadBefore(threadId, cursorScore ?? 0, Z5_PAGE_SIZE, cursorId);
      const page = await Promise.resolve(pageResult);
      if (!page || !Array.isArray(page) || page.length === 0) break;

      for (let i = page.length - 1; i >= 0; i -= 1) {
        const m = page[i] as {
          userId?: unknown;
          catId?: unknown;
          mentions?: unknown;
          timestamp?: unknown;
          deliveredAt?: unknown;
        };
        // F194 Phase Z5 R5 + R6 (cloud Codex round-1+2 P1): system-authored notices 不算 user message。
        // R5 只排除了 'system'；R6 改用 visibility.ts 的 SYSTEM_USER_IDS（含 scheduler + system + 未来扩展）
        // — 与 message store 的 isSystemUserMessage 同口径，scheduler 触发的通知一并排除。
        // 否则一串 system/scheduler notice 会塞满 USER count limit，把真正的 user @ 挤出窗口外。
        const userIdStr = typeof m?.userId === 'string' ? m.userId : null;
        const isUserMessage = userIdStr != null && !SYSTEM_USER_IDS.has(userIdStr) && m?.catId == null;
        if (!isUserMessage) continue;
        // F194 Phase Z5 R8 (cloud Codex round-4 P1) + R9 (砚砚 R8 P1): 1h cutoff 在 isUserMessage 之后
        // 判断，且用 effectiveOrderTime（与 cursor 同口径）。Redis markDelivered 把 thread zset score
        // 改成 deliveredAt，对一条 send-time 老但刚 re-delivered 的 user msg，cutoff 应按 deliveredAt
        // 算（与 Redis 排序对齐）。非 user msg 已 continue 跳过，cutoff 不会误 trip return null。
        const score = effectiveOrderTime(m);
        if (score > 0 && score < cutoffTimestamp) return null;
        userMessagesSeen += 1;
        if (userMessagesSeen > Z5_USER_MESSAGE_COUNT_LIMIT) return null;
        const mentions = Array.isArray(m.mentions) ? (m.mentions as string[]) : [];
        if (mentions.length === 0) continue; // user msg without @ → skip, keep looking earlier
        const routable = this.filterRoutableCats(mentions as CatId[]);
        return routable.length > 0 ? [routable[0]] : null;
      }

      // 页内没找到，准备下一页 cursor = 当前页最旧消息（ascending → page[0]）。
      // R9: cursor.score = effectiveOrderTime(page[0]) 与 Redis zset score 一致。
      const oldest = page[0] as { id?: unknown; timestamp?: unknown; deliveredAt?: unknown };
      if (typeof oldest?.id !== 'string') break;
      const oldestScore = effectiveOrderTime(oldest);
      if (oldestScore <= 0) break;
      // F194 Phase Z5 R11 (砚砚 R10 P2): page-level cutoff — page[0] 是当前页最旧 effective score，
      // 如果它已经早于 cutoff，下一页只会更老（pages 按 effective score asc），无须再翻。
      // 防止高流量 thread (无 user msg in 1h) 把 unbounded loop 拖成全量历史扫描。
      if (oldestScore < cutoffTimestamp) return null;
      cursorScore = oldestScore;
      cursorId = oldest.id;
    }
    return null;
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
    const scope = inferRoutingScope(message);
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

    // Explicit @mentions are user-authored route tokens and may appear anywhere in prose.
    forEachUserMentionCandidate(lowerMessage, (pos) => {
      const matched = findMentionPatternAt(lowerMessage, pos, allPatterns);
      if (matched) {
        recordResolvedMention(matched.catId, pos, seenCats, mentions, routing_warnings);
        return;
      }
      // P2 (codex review 6949db49): an explicit @handle that matched NO registered cat is an
      // unknown handle (e.g. @kimi). Without this, parseAllMentions returns empty mentions + empty
      // warnings, so the caller silently falls back to the default cat with zero user feedback.
      if (hasDomainSuffixedMentionPatternAt(lowerMessage, pos, allPatterns)) return;
      recordUnknownMentionWarning(lowerMessage, pos, seenCats, routing_warnings);
    });

    // Speech aliases like "at 砚砚" stay limited to route-line syntax; otherwise ordinary
    // prose such as "look at codex docs" would become an implicit route.
    if (speechRouteMessage !== lowerMessage) {
      recordRouteLineMentions(speechRouteMessage, allPatterns, seenCats, mentions, routing_warnings);
    }

    mentions.sort((a, b) => a.position - b.position);
    return { mentions, routing_warnings };
  }

  private parseMentions(message: string): { mentions: CatId[]; routing_warnings: CatRoutingError[] } {
    const raw = this.parseMentionsRaw(message);
    return { mentions: raw.mentions.map((m) => m.catId), routing_warnings: raw.routing_warnings };
  }

  /**
   * F078: Parse group mentions (@all, @全体, @全体{breed}, @all-{breed}, @thread, @本帖, @全体参与者).
   * Returns matched CatIds or null if no group mention found.
   * Called BEFORE individual parseMentions — group patterns are longer and take priority.
   *
   * P1 fix: uses token boundary check (same regex as parseMentions) to avoid
   * substring collisions like @allison→@all or @threadsafe→@thread.
   */
  private async parseGroupMentions(
    message: string,
    threadId: string,
  ): Promise<{ cats: CatId[]; matchPosition: number } | null> {
    const lowerMessage = this.normalizeSpeechMentions(message).toLowerCase();
    const excluded = buildMentionExclusionSpans(lowerMessage);

    /** Find first boundary-valid match position, or -1 if not found */
    const findMatchPosition = (pattern: string): number => {
      const lowerPattern = pattern.toLowerCase();
      let found = -1;
      forEachRouteLineMentionCandidate(lowerMessage, (line, lineOffset, candidate) => {
        if (found >= 0) return;
        const candidatePosition = lineOffset + candidate;
        if (isInsideSpan(candidatePosition, excluded)) return;
        if (!line.startsWith(lowerPattern, candidate)) return;
        const end = candidate + lowerPattern.length;
        const charAfter = line[end];
        if (!charAfter || MENTION_TOKEN_BOUNDARY_RE.test(charAfter)) {
          found = candidatePosition;
        }
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
          const fallback = this.pickFallbackCat(new Set());
          return fallback ? [fallback] : [];
        },
      });
    }

    // Breed-scoped patterns: @全体{displayName} and @all-{breedId}
    const allConfigs = catRegistry.getAllConfigs();
    const breedMap = new Map<string, { displayName: string; catIds: CatId[] }>();
    for (const [catId, config] of Object.entries(allConfigs)) {
      if (!config.breedId) continue;
      if (!Object.hasOwn(this.services, catId)) continue;
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
    for (const [breedId, info] of breedMap) {
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
        const fallback = this.pickFallbackCat(new Set());
        return fallback ? [fallback] : [];
      },
    });
    patterns.push({
      pattern: '@all',
      resolve: async () => {
        const allCats = this.filterRoutableCats(Object.keys(this.services));
        if (allCats.length > 0) return allCats;
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
  ): Promise<{ mentions: CatId[]; routing_warnings: CatRoutingError[] }> {
    const groupResult = await this.parseGroupMentions(message, threadId);
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

      // Filter out routing_warnings for group mention keywords — they were already
      // matched by parseGroupMentions and are not individual cat mentions.
      // Only suppress breed handles with ≥1 routable cat (service + available);
      // breeds where all cats are unavailable still warn so the user gets feedback.
      const groupHandles = new Set(['all', 'thread']);
      for (const [catId, config] of Object.entries(catRegistry.getAllConfigs())) {
        if (config.breedId && this.isRoutableCat(catId)) {
          groupHandles.add(`all-${config.breedId}`);
        }
      }
      const filteredWarnings = individual.routing_warnings.filter((w) => {
        if (w.kind !== 'cat_not_found') return true;
        return !groupHandles.has(w.mention.toLowerCase());
      });

      return {
        mentions: [...before, ...groupResult.cats, ...after],
        routing_warnings: filteredWarnings,
      };
    }
    return this.parseMentions(message);
  }

  /**
   * Read-only target resolution: mentions → last-replier (scoped to preferredCats) → default cat.
   * F32-b Phase 2 + #58: preferredCats is a candidate scope, not a dispatch list.
   * Does NOT mutate thread participants.
   */
  private async peekTargets(message: string, threadId: string): Promise<CatId[]> {
    const { mentions: mentionedCats } = await this.parseAllMentions(message, threadId);
    if (mentionedCats.length > 0) return mentionedCats;

    if (this.threadStore) {
      const thread = await this.threadStore.get(threadId);

      // F32-b Phase 2 + #58: preferredCats = candidate scope, not dispatch list
      // R5: Object.hasOwn + dedupe; Cloud P1: Array.isArray guard for corrupted data
      const rawPref = Array.isArray(thread?.preferredCats) ? thread.preferredCats : [];
      const validPreferred = this.filterRoutableCats(rawPref);
      const preferredSet = new Set(validPreferred.map(String));

      // #58: explicit #ideate with multiple preferred cats → dispatch all (user requested parallel)
      const hasExplicitIdeate = /#ideate\b/i.test(message);
      if (hasExplicitIdeate && validPreferred.length > 1) {
        return this.applyThreadRoutingPolicy(thread, message, validPreferred);
      }

      // F229: Concierge threads always route to the configured duty cat (preferredCats).
      // Placed BEFORE findRecentUserMentionFallback: a previous @mention in the concierge
      // thread must not re-route follow-up messages to a non-duty cat. The front-desk duty
      // cat is the always-on responder; explicit @mentions in the current message (parsed
      // above) still override this, but implicit mention carry-over does not.
      if (thread?.threadKind === 'concierge' && validPreferred.length > 0) {
        return this.applyThreadRoutingPolicy(thread, message, validPreferred);
      }

      // F194 Phase Z5 AC-Z16: 优先用上一条 user message 的 mentions 作 fallback 候选集，
      // 不让 thread 里其他猫的发言（vision guard / cross-post）抢路由。
      // co-creator原话："明明 at 的最后一只猫是 47 or 55 但是召唤出来的却是 46"
      const userMentionFallback = await this.findRecentUserMentionFallback(threadId);
      if (userMentionFallback && userMentionFallback.length > 0) {
        return this.applyThreadRoutingPolicy(thread, message, userMentionFallback);
      }

      // F078: last-replier takes absolute priority over preferredCats.
      // User mental model: "no @ = continue with whoever I was talking to".
      // preferredCats only kicks in when there's no conversation history at all.
      // #267: three-tier fallback — (1) any healthy replier (unscoped),
      //   (2) preferred non-errored participant, (3) any non-errored participant.
      const participantsWithActivity = await this.threadStore.getParticipantsWithActivity(threadId);
      const isRoutable = (p: { catId: CatId }) => this.isRoutableCat(p.catId);
      const isHealthy = (p: { lastResponseHealthy?: boolean }) => p.lastResponseHealthy !== false;
      const healthyReplier = participantsWithActivity.find((p) => p.messageCount > 0 && isHealthy(p) && isRoutable(p));
      if (healthyReplier) {
        return this.applyThreadRoutingPolicy(thread, message, [healthyReplier.catId]);
      }
      const preferredFallback = participantsWithActivity.find(
        (p) => isHealthy(p) && isRoutable(p) && preferredSet.has(p.catId as string),
      );
      const anyFallback = participantsWithActivity.find((p) => isHealthy(p) && isRoutable(p));
      const fallbackParticipant = preferredFallback ?? anyFallback;
      if (fallbackParticipant) {
        return this.applyThreadRoutingPolicy(thread, message, [fallbackParticipant.catId]);
      }

      // No healthy participant at all: use first preferred cat
      if (validPreferred.length > 0) {
        return this.applyThreadRoutingPolicy(thread, message, [validPreferred[0]]);
      }

      return this.applyThreadRoutingPolicy(thread, message, [getDefaultCatId()]);
    }

    return [getDefaultCatId()];
  }

  /** Resolve target cats and persist new mentions as thread participants */
  private async resolveTargets(message: string, threadId: string): Promise<CatId[]> {
    const { mentions: mentionedCats } = await this.parseAllMentions(message, threadId);

    if (mentionedCats.length > 0) {
      if (this.threadStore) {
        await this.threadStore.addParticipants(threadId, mentionedCats);
      }
      return mentionedCats;
    }

    if (this.threadStore) {
      const thread = await this.threadStore.get(threadId);

      // F32-b Phase 2 + #58: preferredCats = candidate scope, not dispatch list
      // R5: Object.hasOwn + dedupe; Cloud P1: Array.isArray guard for corrupted data
      const rawPref = Array.isArray(thread?.preferredCats) ? thread.preferredCats : [];
      const validPreferred = this.filterRoutableCats(rawPref);
      const preferredSet = new Set(validPreferred.map(String));

      // #58: explicit #ideate with multiple preferred cats → dispatch all (user requested parallel)
      const hasExplicitIdeate = /#ideate\b/i.test(message);
      if (hasExplicitIdeate && validPreferred.length > 1) {
        return this.applyThreadRoutingPolicy(thread, message, validPreferred);
      }

      // F229: Concierge threads always route to the configured duty cat (preferredCats).
      // Placed BEFORE findRecentUserMentionFallback — see matching comment in peekTargets.
      if (thread?.threadKind === 'concierge' && validPreferred.length > 0) {
        return this.applyThreadRoutingPolicy(thread, message, validPreferred);
      }

      // F194 Phase Z5 AC-Z16: 优先用上一条 user message 的 mentions 作 fallback 候选集，
      // 不让 thread 里其他猫的发言（vision guard / cross-post）抢路由。
      // co-creator原话："明明 at 的最后一只猫是 47 or 55 但是召唤出来的却是 46"
      const userMentionFallback = await this.findRecentUserMentionFallback(threadId);
      if (userMentionFallback && userMentionFallback.length > 0) {
        return this.applyThreadRoutingPolicy(thread, message, userMentionFallback);
      }

      // F078 + #58: last-replier takes priority over preferred cats (user mental model)
      // #267: three-tier fallback (same as peekTargets)
      const participantsWithActivity = await this.threadStore.getParticipantsWithActivity(threadId);
      const isRoutable = (p: { catId: CatId }) => this.isRoutableCat(p.catId);
      const isHealthy = (p: { lastResponseHealthy?: boolean }) => p.lastResponseHealthy !== false;
      const healthyReplier = participantsWithActivity.find((p) => p.messageCount > 0 && isHealthy(p) && isRoutable(p));
      if (healthyReplier) {
        return this.applyThreadRoutingPolicy(thread, message, [healthyReplier.catId]);
      }
      const preferredFallback = participantsWithActivity.find(
        (p) => isHealthy(p) && isRoutable(p) && preferredSet.has(p.catId as string),
      );
      const anyFallback = participantsWithActivity.find((p) => isHealthy(p) && isRoutable(p));
      const fallbackParticipant = preferredFallback ?? anyFallback;
      if (fallbackParticipant) {
        return this.applyThreadRoutingPolicy(thread, message, [fallbackParticipant.catId]);
      }

      // No healthy participant at all: use first preferred cat
      if (validPreferred.length > 0) {
        return this.applyThreadRoutingPolicy(thread, message, [validPreferred[0]]);
      }

      return this.applyThreadRoutingPolicy(thread, message, [getDefaultCatId()]);
    }

    return [getDefaultCatId()];
  }

  /** Build shared strategy dependencies (public for ModeOrchestrator) */
  getStrategyDeps(): RouteStrategyDeps {
    const apiPort = process.env.API_SERVER_PORT ?? '3004';
    return {
      services: this.services,
      invocationDeps: {
        registry: this.registry,
        sessionManager: this.sessionManager,
        threadStore: this.threadStore,
        apiUrl: `http://127.0.0.1:${apiPort}`,
        ...(this.taskProgressStore ? { taskProgressStore: this.taskProgressStore } : {}),
        ...(this.sessionChainStore ? { sessionChainStore: this.sessionChainStore } : {}),
        ...(this.runtimeSessionStore ? { runtimeSessionStore: this.runtimeSessionStore } : {}),
        ...(this.transcriptWriter ? { transcriptWriter: this.transcriptWriter } : {}),
        ...(this.transcriptReader ? { transcriptReader: this.transcriptReader } : {}),
        ...(this.sessionSealer ? { sessionSealer: this.sessionSealer } : {}),
        ...(this.taskStore ? { taskStore: this.taskStore } : {}),
        ...(this.workflowSopStore ? { workflowSopStore: this.workflowSopStore } : {}),
        ...(this.executionDigestStore ? { executionDigestStore: this.executionDigestStore } : {}),
        ...(this.tmuxGateway ? { tmuxGateway: this.tmuxGateway } : {}),
        ...(this.agentPaneRegistry ? { agentPaneRegistry: this.agentPaneRegistry } : {}),
        ...(this.signalArticleLookup ? { signalArticleLookup: this.signalArticleLookup } : {}),
        ...(this.guideSessionStore ? { guideSessionStore: this.guideSessionStore } : {}),
        ...(this.dismissTracker ? { dismissTracker: this.dismissTracker } : {}),
        ...(this.conciergeConfigStore ? { conciergeConfigStore: this.conciergeConfigStore } : {}),
        ...(this.conciergeHandleMapStore ? { conciergeHandleMapStore: this.conciergeHandleMapStore } : {}),
        ...(this.conciergeTriagePlanStore ? { conciergeTriagePlanStore: this.conciergeTriagePlanStore } : {}),
      },
      messageStore: this.messageStore,
      deliveryCursorStore: this.deliveryCursorStore,
      ...(this.draftStore ? { draftStore: this.draftStore } : {}),
      ...(this.socketManager ? { socketManager: this.socketManager } : {}),
      ...(this.packStore ? { packStore: this.packStore } : {}),
      ...(this.evidenceStore ? { evidenceStore: this.evidenceStore } : {}),
      ...(this.toolUsageCounter ? { toolUsageCounter: this.toolUsageCounter } : {}),
      ...(this.toolEventLog ? { toolEventLog: this.toolEventLog } : {}),
      ...(this.skillLoadEventLog ? { skillLoadEventLog: this.skillLoadEventLog } : {}),
      ...(this.worldContextProvider ? { worldContextProvider: this.worldContextProvider } : {}),
      ...(this.worldStore ? { worldStore: this.worldStore } : {}),
      ...(this.frustrationIssueStore ? { frustrationIssueStore: this.frustrationIssueStore } : {}),
      ...(this.pendingRequestStore ? { pendingRequestStore: this.pendingRequestStore } : {}),
      ...(this.ballCustody ? { ballCustody: this.ballCustody } : {}),
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
    options?: { persist?: boolean },
  ): Promise<{ targetCats: CatId[]; intent: IntentResult; hasMentions: boolean; routing_warnings: CatRoutingError[] }> {
    const resolvedThreadId = threadId ?? DEFAULT_THREAD_ID;
    // Capture both valid mentions AND routing_warnings (for disabled/not-found cats).
    // routing_warnings lets callers (e.g. messages.ts) surface explicit feedback when
    // a user's @mention silently fell back to a different cat (Thread 1 bug: @kimi→opus).
    const allMentions = await this.parseAllMentions(message, resolvedThreadId);
    const hasMentions = allMentions.mentions.length > 0;
    const routing_warnings = allMentions.routing_warnings;
    const targetCats = options?.persist
      ? await this.resolveTargets(message, resolvedThreadId)
      : await this.peekTargets(message, resolvedThreadId);
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
  ): AsyncIterable<AgentMessage> {
    const resolvedThreadId = threadId ?? DEFAULT_THREAD_ID;
    const targetCats = await this.resolveTargets(message, resolvedThreadId);
    const intent = parseIntent(message, targetCats.length);
    const strategy = intent.intent === 'ideate' && targetCats.length > 1 ? 'parallel' : 'serial';
    const cleanMessage = stripIntentTags(message);

    const routeSpan = routeTracer.startSpan('cat_cafe.route', {
      attributes: {
        [ROUTING_TARGET_CATS]: (targetCats as string[]).join(','),
        [ROUTING_INTENT]: intent.intent,
        [ROUTING_STRATEGY]: strategy,
      },
    });

    // Fetch thread for thinkingMode + update lastActive
    // Default to play mode when no threadStore is available: stream thinking stays isolated.
    let legacyThinkingMode: 'debug' | 'play' = 'play';
    if (this.threadStore) {
      const thread = await this.threadStore.get(resolvedThreadId);
      if (thread) {
        legacyThinkingMode = thread.thinkingMode ?? 'play';
      }
      await this.threadStore.updateLastActive(resolvedThreadId);
    }

    const storedUserMessage = await this.messageStore.append({
      userId,
      catId: null,
      content: message, // Store original (with tags) for audit
      mentions: targetCats,
      timestamp: Date.now(),
      threadId: resolvedThreadId,
      ...(contentBlocks ? { contentBlocks } : {}),
    });

    // F222 Phase B+C: Text frustration + retry burst detection
    if (this.frustrationIssueStore) {
      try {
        const { detectTextFrustration } = await import('../../frustration/text-frustration-keywords.js');
        const detection = await this.collectAndDetectTextFrustration(resolvedThreadId, detectTextFrustration);
        const { evaluate } = await import('../../frustration/FrustrationDetector.js');
        const frustDeps = {
          frustrationIssueStore: this.frustrationIssueStore,
          messageStore: this.messageStore,
          socketManager: this.socketManager as
            | import('../../../../../infrastructure/websocket/index.js').SocketManager
            | undefined,
        };
        const baseSigCtx = { threadId: resolvedThreadId, userId, catId: (targetCats[0] ?? 'unknown') as string };

        // Signal: text_frustration (Phase B)
        if (detection.matched) {
          await evaluate(
            {
              signal: {
                type: 'text_frustration' as const,
                matchedKeywords: detection.matchedKeywords,
                matchCount: detection.matchCount,
                recentUserMessages: detection.recentUserMessages,
              },
              ...baseSigCtx,
            },
            frustDeps,
          );
        }

        // Signal: retry_burst (Phase C AC-C2) — same message sent ≥3 times
        const { detectRetryBurst } = await import('../../frustration/retry-burst-detector.js');
        const retryResult = detectRetryBurst(message, detection.recentUserMessages);
        if (retryResult.matched) {
          await evaluate(
            {
              signal: {
                type: 'retry_burst' as const,
                matchCount: retryResult.matchCount,
                repeatedPrefix: retryResult.repeatedPrefix,
              },
              ...baseSigCtx,
            },
            frustDeps,
          );
        }
      } catch {
        // Non-blocking
      }
    }

    const strategyDeps = this.getStrategyDeps();
    const routeOptions = {
      contentBlocks,
      uploadDir,
      signal,
      promptTags: intent.promptTags,
      currentUserMessageId: storedUserMessage.id,
      thinkingMode: legacyThinkingMode,
      routeSpan,
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
    options?: {
      contentBlocks?: readonly MessageContent[];
      uploadDir?: string;
      signal?: AbortSignal;
      /** F-parallel-cancel: per-cat signal resolver — route-parallel gives each concurrent
       *  cat its own slot signal so canceling one cat does not abort its siblings. */
      signalForCat?: (catId: CatId) => AbortSignal | undefined;
      queueHasQueuedMessages?: (threadId: string) => boolean;
      hasQueuedOrActiveAgentForCat?: (threadId: string, catId: string) => boolean;
      /** F185 Phase B: deferred A2A enqueue when fairness gate blocks text-scan expansion */
      deferA2AEnqueue?: RouteOptions['deferA2AEnqueue'];
      invocationController?: AbortController;
      trackA2ASlot?: (threadId: string, catId: CatId, userId: string, controller: AbortController) => void;
      completeA2ASlots?: (threadId: string, catIds: readonly CatId[], controller: AbortController) => void;
      /** ADR-008 S3: pass a Map to collect cursor boundaries; caller acks after succeeded */
      cursorBoundaries?: Map<string, string>;
      /** P1-2: pass to track persistence failures across generator boundary */
      persistenceContext?: PersistenceContext;
      /** F108: parentInvocationId for WorklistRegistry concurrent isolation */
      parentInvocationId?: string;
      /** F153: caller trace context for cross-route A2A propagation */
      callerTraceContext?: CallerTraceContext;
      /** Explicit A2A trigger message ID for queue-dispatched stream reply threading */
      a2aTriggerMessageId?: string;
      /** F222 P1: Whether this route is eligible for frustration auto-issue detection.
       *  true/undefined = user-origin (eligible, default for backward compat).
       *  false = agent/connector-origin (A2A handoff) — suppress detection. */
      frustrationAutoIssueEligible?: boolean;
      /** #949 P2: Whether verdict-without-pass warning fires at route end.
       *  true/undefined = warn (default). false = suppress for connector-sourced flows only. */
      verdictPassWarningEnabled?: boolean;
    },
  ): AsyncIterable<AgentMessage> {
    const cleanMessage = stripIntentTags(message);
    const strategy = intent.intent === 'ideate' && targetCats.length > 1 ? 'parallel' : 'serial';

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

    // Fetch thread for thinkingMode + update lastActive
    // Default to play mode when no threadStore is available: stream thinking stays isolated.
    let thinkingMode: 'debug' | 'play' = 'play';
    if (this.threadStore) {
      const thread = await this.threadStore.get(threadId);
      if (thread) {
        thinkingMode = thread.thinkingMode ?? 'play';
      }
      await this.threadStore.updateLastActive(threadId);
    }

    // F222 Phase B+C: Text frustration + retry burst detection (production path)
    // F222 P1: Skip for A2A/connector origins — only detect frustration on user-driven routes
    if (this.frustrationIssueStore && options?.frustrationAutoIssueEligible !== false) {
      try {
        const { detectTextFrustration } = await import('../../frustration/text-frustration-keywords.js');
        const detection = await this.collectAndDetectTextFrustration(threadId, detectTextFrustration);
        const { evaluate } = await import('../../frustration/FrustrationDetector.js');
        const frustDeps = {
          frustrationIssueStore: this.frustrationIssueStore,
          messageStore: this.messageStore,
          socketManager: this.socketManager as
            | import('../../../../../infrastructure/websocket/index.js').SocketManager
            | undefined,
        };
        const baseSigCtx = { threadId, userId, catId: (targetCats[0] ?? 'unknown') as string };

        if (detection.matched) {
          await evaluate(
            {
              signal: {
                type: 'text_frustration' as const,
                matchedKeywords: detection.matchedKeywords,
                matchCount: detection.matchCount,
                recentUserMessages: detection.recentUserMessages,
              },
              ...baseSigCtx,
            },
            frustDeps,
          );
        }

        // Signal: retry_burst (Phase C AC-C2)
        const { detectRetryBurst } = await import('../../frustration/retry-burst-detector.js');
        const retryResult = detectRetryBurst(message, detection.recentUserMessages);
        if (retryResult.matched) {
          await evaluate(
            {
              signal: {
                type: 'retry_burst' as const,
                matchCount: retryResult.matchCount,
                repeatedPrefix: retryResult.repeatedPrefix,
              },
              ...baseSigCtx,
            },
            frustDeps,
          );
        }
      } catch {
        // Non-blocking
      }
    }

    const strategyDeps = this.getStrategyDeps();
    const routeOptions = {
      contentBlocks: options?.contentBlocks,
      uploadDir: options?.uploadDir,
      signal: options?.signal,
      signalForCat: options?.signalForCat,
      queueHasQueuedMessages: options?.queueHasQueuedMessages,
      hasQueuedOrActiveAgentForCat: options?.hasQueuedOrActiveAgentForCat,
      deferA2AEnqueue: options?.deferA2AEnqueue,
      invocationController: options?.invocationController,
      trackA2ASlot: options?.trackA2ASlot,
      completeA2ASlots: options?.completeA2ASlots,
      promptTags: intent.promptTags,
      currentUserMessageId: userMessageId,
      a2aTriggerMessageId: options?.a2aTriggerMessageId,
      thinkingMode,
      ...(options?.cursorBoundaries ? { cursorBoundaries: options.cursorBoundaries } : {}),
      ...(options?.persistenceContext ? { persistenceContext: options.persistenceContext } : {}),
      ...(options?.parentInvocationId ? { parentInvocationId: options.parentInvocationId } : {}),
      routeSpan,
      // F222 P1: thread provenance flag so route-serial/route-parallel can gate detection
      ...(options?.frustrationAutoIssueEligible !== undefined
        ? { frustrationAutoIssueEligible: options.frustrationAutoIssueEligible }
        : {}),
      // #949 P2: connector-sourced verdict-pass warning suppression
      ...(options?.verdictPassWarningEnabled !== undefined
        ? { verdictPassWarningEnabled: options.verdictPassWarningEnabled }
        : {}),
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
      if (userMessageId) {
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
      } catch (err) {
        log.error({ catId, err }, `[ackCollectedCursors] failed`);
      }
    }
  }
}
