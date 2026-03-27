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

import type { CatId, MessageContent } from '@cat-cafe/shared';
import { catRegistry, escapeRegExp } from '@cat-cafe/shared';
import type { SessionStore } from '@cat-cafe/shared/utils';
import { getDefaultCatId, isCatAvailable } from '../../../../../config/cat-config-loader.js';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import type { IntentResult } from '../../context/IntentParser.js';
import { parseIntent, stripIntentTags } from '../../context/IntentParser.js';
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
import type { AgentMessage, AgentService } from '../../types.js';
import type { InvocationRegistry } from '../invocation/InvocationRegistry.js';
import type { TaskProgressStore } from '../invocation/TaskProgressStore.js';
import type { AgentRegistry } from '../registry/AgentRegistry.js';
import type { PersistenceContext, RouteStrategyDeps } from '../routing/route-helpers.js';
import { routeParallel } from '../routing/route-parallel.js';
import { routeSerial } from '../routing/route-serial.js';

const log = createModuleLogger('agent-router');

/** Parsed mention with position for ordering */
interface ParsedMention {
  catId: CatId;
  position: number;
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
  private speechMentionRe: RegExp;

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
   * Prevents `@opus-45` from also matching `@opus` via consumed interval exclusion.
   *
   * Algorithm:
   * 1. Collect ALL patterns from ALL cats, sort by length descending (longest first)
   * 2. For each pattern, find all occurrences in the message
   * 3. Check token boundary (char after pattern must be whitespace/punctuation/EOF)
   * 4. Check consumed intervals (skip if already matched by a longer pattern)
   * 5. Deduplicate by catId, preserve first-occurrence ordering
   */
  private parseMentions(message: string): CatId[] {
    const lowerMessage = this.normalizeSpeechMentions(message).toLowerCase();

    // 1. Collect all mentionPatterns → catId, sorted by length descending
    const allPatterns: Array<{ pattern: string; catId: CatId }> = [];
    const allConfigs = catRegistry.getAllConfigs();
    for (const config of Object.values(allConfigs)) {
      for (const pattern of config.mentionPatterns) {
        allPatterns.push({ pattern: pattern.toLowerCase(), catId: config.id });
      }
    }
    allPatterns.sort((a, b) => b.pattern.length - a.pattern.length); // longest first

    // 2-4. Match with consumed intervals
    const consumed: Array<[number, number]> = []; // [start, end)
    const mentions: ParsedMention[] = [];
    const seenCats = new Set<string>();

    for (const { pattern, catId } of allPatterns) {
      let searchFrom = 0;
      while (searchFrom < lowerMessage.length) {
        const pos = lowerMessage.indexOf(pattern, searchFrom);
        if (pos === -1) break;

        const end = pos + pattern.length;

        // Token boundary: char after pattern must be whitespace/punctuation/EOF
        const charAfter = lowerMessage[end];
        const isEndBoundary = !charAfter || /[\s,.:;!?()[\]{}<>，。！？、：；（）【】《》「」『』〈〉]/.test(charAfter);

        // Not in an already-consumed interval
        const isConsumed = consumed.some(([s, e]) => pos >= s && pos < e);

        if (isEndBoundary && !isConsumed) {
          consumed.push([pos, end]);
          if (!isCatAvailable(catId as string)) {
            searchFrom = pos + 1;
            continue;
          }
          if (!seenCats.has(catId as string)) {
            seenCats.add(catId as string);
            mentions.push({ catId, position: pos });
          } else {
            // Shortest alias may appear earlier; update to earliest position
            const existing = mentions.find((m) => m.catId === catId);
            if (existing && pos < existing.position) {
              existing.position = pos;
            }
          }
        }
        searchFrom = pos + 1;
      }
    }

    // 5. Return ordered by first occurrence
    mentions.sort((a, b) => a.position - b.position);
    return mentions.map((m) => m.catId);
  }

  /**
   * F078: Parse group mentions (@all, @全体, @全体{breed}, @all-{breed}, @thread, @本帖, @全体参与者).
   * Returns matched CatIds or null if no group mention found.
   * Called BEFORE individual parseMentions — group patterns are longer and take priority.
   *
   * P1 fix: uses token boundary check (same regex as parseMentions) to avoid
   * substring collisions like @allison→@all or @threadsafe→@thread.
   */
  private async parseGroupMentions(message: string, threadId: string): Promise<CatId[] | null> {
    const lowerMessage = this.normalizeSpeechMentions(message).toLowerCase();

    // Reuse parseMentions' token boundary regex
    const boundaryRe = /[\s,.:;!?()[\]{}<>，。！？、：；（）【】《》「」『』〈〉]/;

    /** Check if pattern appears in message with a valid token boundary after it */
    const matchesWithBoundary = (pattern: string): boolean => {
      const lowerPattern = pattern.toLowerCase();
      let searchFrom = 0;
      while (searchFrom < lowerMessage.length) {
        const pos = lowerMessage.indexOf(lowerPattern, searchFrom);
        if (pos === -1) return false;
        const end = pos + lowerPattern.length;
        const charAfter = lowerMessage[end];
        if (!charAfter || boundaryRe.test(charAfter)) return true;
        searchFrom = pos + 1;
      }
      return false;
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
      if (matchesWithBoundary(pattern)) {
        return resolve();
      }
    }

    return null;
  }

  /**
   * F078: Unified mention parser — group mentions first, then individual.
   */
  private async parseAllMentions(message: string, threadId: string): Promise<CatId[]> {
    const groupResult = await this.parseGroupMentions(message, threadId);
    if (groupResult !== null) return groupResult;
    return this.parseMentions(message);
  }

  /**
   * Read-only target resolution: mentions → last-replier (scoped to preferredCats) → default cat.
   * F32-b Phase 2 + #58: preferredCats is a candidate scope, not a dispatch list.
   * Does NOT mutate thread participants.
   */
  private async peekTargets(message: string, threadId: string): Promise<CatId[]> {
    const mentionedCats = await this.parseAllMentions(message, threadId);
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

      // F078 + #58: last-replier takes priority, scoped to preferred cats when set
      // #267: two-tier fallback — (1) prefer cats with successful response history,
      //   (2) then any non-errored participant. This prevents never-responded cats
      //   from short-circuiting the search for the next healthy responder.
      const participantsWithActivity = await this.threadStore.getParticipantsWithActivity(threadId);
      const matchScope = (p: { catId: CatId }) =>
        this.isRoutableCat(p.catId) && (preferredSet.size === 0 || preferredSet.has(p.catId as string));
      const healthyReplier = participantsWithActivity.find(
        (p) => p.messageCount > 0 && p.lastResponseHealthy !== false && matchScope(p),
      );
      if (healthyReplier) {
        return this.applyThreadRoutingPolicy(thread, message, [healthyReplier.catId]);
      }
      // No cat with successful response — fall back to any non-errored participant
      const fallbackParticipant = participantsWithActivity.find(
        (p) => p.lastResponseHealthy !== false && matchScope(p),
      );
      if (fallbackParticipant) {
        return this.applyThreadRoutingPolicy(thread, message, [fallbackParticipant.catId]);
      }

      // No last-replier (or last-replier not in preferred set): use first preferred cat
      if (validPreferred.length > 0) {
        return this.applyThreadRoutingPolicy(thread, message, [validPreferred[0]]);
      }

      return this.applyThreadRoutingPolicy(thread, message, [getDefaultCatId()]);
    }

    return [getDefaultCatId()];
  }

  /** Resolve target cats and persist new mentions as thread participants */
  private async resolveTargets(message: string, threadId: string): Promise<CatId[]> {
    const mentionedCats = await this.parseAllMentions(message, threadId);

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

      // F078 + #58: last-replier takes priority, scoped to preferred cats when set
      // #267: two-tier fallback (same as peekTargets)
      const participantsWithActivity = await this.threadStore.getParticipantsWithActivity(threadId);
      const matchScope = (p: { catId: CatId }) =>
        this.isRoutableCat(p.catId) && (preferredSet.size === 0 || preferredSet.has(p.catId as string));
      const healthyReplier = participantsWithActivity.find(
        (p) => p.messageCount > 0 && p.lastResponseHealthy !== false && matchScope(p),
      );
      if (healthyReplier) {
        return this.applyThreadRoutingPolicy(thread, message, [healthyReplier.catId]);
      }
      const fallbackParticipant = participantsWithActivity.find(
        (p) => p.lastResponseHealthy !== false && matchScope(p),
      );
      if (fallbackParticipant) {
        return this.applyThreadRoutingPolicy(thread, message, [fallbackParticipant.catId]);
      }

      // No last-replier (or last-replier not in preferred set): use first preferred cat
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
        ...(this.transcriptWriter ? { transcriptWriter: this.transcriptWriter } : {}),
        ...(this.transcriptReader ? { transcriptReader: this.transcriptReader } : {}),
        ...(this.sessionSealer ? { sessionSealer: this.sessionSealer } : {}),
        ...(this.taskStore ? { taskStore: this.taskStore } : {}),
        ...(this.workflowSopStore ? { workflowSopStore: this.workflowSopStore } : {}),
        ...(this.executionDigestStore ? { executionDigestStore: this.executionDigestStore } : {}),
        ...(this.tmuxGateway ? { tmuxGateway: this.tmuxGateway } : {}),
        ...(this.agentPaneRegistry ? { agentPaneRegistry: this.agentPaneRegistry } : {}),
        ...(this.signalArticleLookup ? { signalArticleLookup: this.signalArticleLookup } : {}),
      },
      messageStore: this.messageStore,
      deliveryCursorStore: this.deliveryCursorStore,
      ...(this.draftStore ? { draftStore: this.draftStore } : {}),
      ...(this.socketManager ? { socketManager: this.socketManager } : {}),
      ...(this.packStore ? { packStore: this.packStore } : {}),
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
  ): Promise<{ targetCats: CatId[]; intent: IntentResult }> {
    const resolvedThreadId = threadId ?? DEFAULT_THREAD_ID;
    const targetCats = options?.persist
      ? await this.resolveTargets(message, resolvedThreadId)
      : await this.peekTargets(message, resolvedThreadId);
    const intent = parseIntent(message, targetCats.length);
    return { targetCats, intent };
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
    const cleanMessage = stripIntentTags(message);

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

    const strategyDeps = this.getStrategyDeps();
    const routeOptions = {
      contentBlocks,
      uploadDir,
      signal,
      promptTags: intent.promptTags,
      currentUserMessageId: storedUserMessage.id,
      thinkingMode: legacyThinkingMode,
    };

    if (intent.intent === 'ideate' && targetCats.length > 1) {
      yield* routeParallel(strategyDeps, targetCats, cleanMessage, userId, resolvedThreadId, routeOptions);
    } else {
      yield* routeSerial(strategyDeps, targetCats, cleanMessage, userId, resolvedThreadId, routeOptions);
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
      queueHasQueuedMessages?: (threadId: string) => boolean;
      hasQueuedOrActiveAgentForCat?: (threadId: string, catId: string) => boolean;
      /** ADR-008 S3: pass a Map to collect cursor boundaries; caller acks after succeeded */
      cursorBoundaries?: Map<string, string>;
      /** P1-2: pass to track persistence failures across generator boundary */
      persistenceContext?: PersistenceContext;
      /** F108: parentInvocationId for WorklistRegistry concurrent isolation */
      parentInvocationId?: string;
    },
  ): AsyncIterable<AgentMessage> {
    const cleanMessage = stripIntentTags(message);

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

    const strategyDeps = this.getStrategyDeps();
    const routeOptions = {
      contentBlocks: options?.contentBlocks,
      uploadDir: options?.uploadDir,
      signal: options?.signal,
      queueHasQueuedMessages: options?.queueHasQueuedMessages,
      hasQueuedOrActiveAgentForCat: options?.hasQueuedOrActiveAgentForCat,
      promptTags: intent.promptTags,
      currentUserMessageId: userMessageId,
      thinkingMode,
      ...(options?.cursorBoundaries ? { cursorBoundaries: options.cursorBoundaries } : {}),
      ...(options?.persistenceContext ? { persistenceContext: options.persistenceContext } : {}),
      ...(options?.parentInvocationId ? { parentInvocationId: options.parentInvocationId } : {}),
    };

    if (intent.intent === 'ideate' && targetCats.length > 1) {
      yield* routeParallel(strategyDeps, targetCats, cleanMessage, userId, threadId, routeOptions);
    } else {
      yield* routeSerial(strategyDeps, targetCats, cleanMessage, userId, threadId, routeOptions);
    }
  }

  /**
   * ADR-008 S3: Ack all cursor boundaries collected during execution.
   * Call ONLY after InvocationRecord.status = 'succeeded'.
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
