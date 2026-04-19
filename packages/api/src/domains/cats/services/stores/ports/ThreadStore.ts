/**
 * Thread Store
 * 对话管理：创建、查询、参与者追踪
 *
 * 内存实现，Map-based + LRU 淘汰。
 * Phase 3.3 可扩展 Redis 版本。
 */

import type { CatId, ThreadPhase } from '@cat-cafe/shared';
import { generateThreadId } from '@cat-cafe/shared';

/** Default thread ID for the lobby (backwards-compatible single-thread mode) */
export const DEFAULT_THREAD_ID = 'default';

/**
 * F032 Phase C: Participant activity data for reviewer matching.
 */
export interface ThreadParticipantActivity {
  catId: CatId;
  /** Unix timestamp of last message from this cat in the thread */
  lastMessageAt: number;
  /** Total message count from this cat in the thread */
  messageCount: number;
  /** #267: false when the cat's last response was an error (API failure, capacity, etc.) */
  lastResponseHealthy?: boolean;
}

/**
 * F042 Routing Policy (v1)
 * Thread-scoped routing preferences by "intent/scope".
 *
 * NOTE: This is NOT global availability.
 * - Global roster `available=false` = technically unavailable/offline.
 * - Thread routingPolicy = temporary preferences (budget, focus, etc.).
 */
export type ThreadRoutingScope = 'review' | 'architecture';

export interface ThreadRoutingRule {
  /** Prefer placing these cats first (may be injected if missing). */
  preferCats?: CatId[];
  /** Avoid routing to these cats unless explicitly @mentioned. */
  avoidCats?: CatId[];
  /** Human-readable reason (e.g. "budget"). */
  reason?: string;
  /** Optional expiry (epoch ms). When expired, rule is ignored. */
  expiresAt?: number;
}

export interface ThreadRoutingPolicyV1 {
  v: 1;
  scopes?: Partial<Record<ThreadRoutingScope, ThreadRoutingRule>>;
}

/** F065 Phase B + F148 VG-3: Rolling thread-level memory across sealed sessions. */
export interface ThreadMemoryV1 {
  v: 1;
  /** Rolling summary text */
  summary: string;
  /** Number of sealed sessions incorporated into this memory */
  sessionsIncorporated: number;
  /** Unix timestamp of last update */
  updatedAt: number;
  /** VG-3: Key decisions extracted from sessions (max 8) */
  decisions?: string[];
  /** VG-3: Open questions extracted from sessions (max 5) */
  openQuestions?: string[];
  /** VG-3: Referenced artifacts — ADRs, Feature IDs (max 8) */
  artifacts?: string[];
}

export type MentionRoutingSuppressionReason = 'no_action' | 'cross_paragraph' | 'inline_action';
export type MentionActionabilityMode = 'strict' | 'relaxed';

export interface ThreadMentionRoutingFeedbackItem {
  targetCatId: CatId;
  reason: MentionRoutingSuppressionReason;
}

export interface ThreadMentionRoutingFeedback {
  /** Optional source message id that triggered the suppression record. */
  sourceMessageId?: string;
  /** Unix timestamp when suppression was recorded. */
  sourceTimestamp: number;
  /** Suppressed mention targets + reason for each target. */
  items: ThreadMentionRoutingFeedbackItem[];
}

/**
 * A conversation thread
 */
export interface Thread {
  id: string;
  projectPath: string;
  title: string | null;
  createdBy: string;
  participants: CatId[];
  lastActiveAt: number;
  createdAt: number;
  pinned?: boolean;
  pinnedAt?: number | null;
  favorited?: boolean;
  favoritedAt?: number | null;
  /** Thinking visibility mode: play = cats can't see each other's thinking, debug = cats share thinking. Default: debug */
  thinkingMode?: 'debug' | 'play';
  /**
   * F046 D1 hot switch:
   * strict  = @mention and action keyword must be in the same paragraph.
   * relaxed = allow one blank line between @mention paragraph and action paragraph.
   */
  mentionActionabilityMode?: MentionActionabilityMode;
  /** F32-b Phase 2: Thread-level cat preference. When set, messages without @mention route to these cats instead of participants/default. */
  preferredCats?: CatId[];
  /** F049: workflow phase for dispatch/intent guidance */
  phase?: ThreadPhase;
  /** F049 Phase2: reverse link for backlog dispatch provenance */
  backlogItemId?: string;
  /** F042: Thread-scoped routing policy (by intent/scope). */
  routingPolicy?: ThreadRoutingPolicyV1;
  /** F065 Phase B: Rolling memory across sealed sessions */
  threadMemory?: ThreadMemoryV1;
  /** F079: Active voting state */
  votingState?: VotingStateV1;
  /** UI bubble display override: thinking block expand/collapse. 'global' = follow config hub default. */
  bubbleThinking?: 'global' | 'expanded' | 'collapsed';
  /** UI bubble display override: CLI output block expand/collapse. 'global' = follow config hub default. */
  bubbleCli?: 'global' | 'expanded' | 'collapsed';
  /** F092: Voice companion mode — when true, cats should prioritize audio rich blocks. */
  voiceMode?: boolean;
  /** F095 Phase D: Soft-delete timestamp. null/undefined = not deleted. */
  deletedAt?: number | null;
  /** F087: CVO Bootcamp onboarding state. */
  bootcampState?: BootcampStateV1;
  /** F088 Phase G: Connector Hub thread state — marks this thread as an IM Hub for command isolation. */
  connectorHubState?: ConnectorHubStateV1;
  /** F168: Auto-switch workspace panel when this thread is opened. */
  preferredWorkspaceMode?: 'dev' | 'recall' | 'schedule' | 'tasks' | 'community';
}

/** F088 Phase G: Connector Hub thread state for IM command isolation. */
export interface ConnectorHubStateV1 {
  v: 1;
  /** Which connector this hub serves (e.g. 'feishu', 'telegram'). */
  connectorId: string;
  /** The external chat ID this hub is bound to. */
  externalChatId: string;
  /** When this hub was created. */
  createdAt: number;
  /** G+ audit: timestamp of the most recent command exchange routed through this hub. */
  lastCommandAt?: number;
}

/** F087: Bootcamp phase for CVO onboarding */
export type BootcampPhase =
  | 'phase-0-select-cat'
  | 'phase-1-intro'
  | 'phase-2-env-check'
  | 'phase-3-config-help'
  | 'phase-3.5-advanced'
  | 'phase-4-task-select'
  | 'phase-5-kickoff'
  | 'phase-6-design'
  | 'phase-7-dev'
  | 'phase-8-review'
  | 'phase-9-complete'
  | 'phase-10-retro'
  | 'phase-11-farewell';

export interface BootcampStateV1 {
  v: 1;
  phase: BootcampPhase;
  leadCat?: CatId;
  selectedTaskId?: string;
  envCheck?: Record<string, { ok: boolean; version?: string; note?: string }>;
  advancedFeatures?: Record<string, 'available' | 'unavailable' | 'skipped'>;
  startedAt: number;
  completedAt?: number;
}

/** F155: Guide session status */
export type GuideStatus = 'offered' | 'awaiting_choice' | 'active' | 'completed' | 'cancelled';

/** F155: Scene-based bidirectional guide state — thread-level authority */
export interface GuideStateV1 {
  v: 1;
  guideId: string;
  status: GuideStatus;
  /** Owning user for default-thread guide state. */
  userId?: string;
  currentStep?: number;
  offeredAt: number;
  startedAt?: number;
  completedAt?: number;
  /** True after the first agent turn has seen the completion (one-shot consumption). */
  completionAcked?: boolean;
  /** catId that offered this guide (prevents multi-cat duplicate offers). */
  offeredBy?: string;
}

/** F079: Voting state stored in thread metadata */
export interface VotingStateV1 {
  v: 1;
  question: string;
  options: string[];
  votes: Record<string, string>; // catId/userId -> option
  anonymous: boolean;
  deadline: number; // timestamp
  createdBy: string;
  status: 'active' | 'closed';
  /** Phase 2: designated voters (catIds). When set, auto-close when all voted. */
  voters?: string[];
  /** Gap 4: catId that initiated the vote (only set for cat-initiated votes via MCP). */
  initiatedByCat?: string;
}

/**
 * Common interface for thread stores (in-memory and future Redis).
 */
export interface IThreadStore {
  create(userId: string, title?: string, projectPath?: string): Thread | Promise<Thread>;
  get(threadId: string): Thread | null | Promise<Thread | null>;
  list(userId: string): Thread[] | Promise<Thread[]>;
  listByProject(userId: string, projectPath: string): Thread[] | Promise<Thread[]>;
  addParticipants(threadId: string, catIds: CatId[]): void | Promise<void>;
  getParticipants(threadId: string): CatId[] | Promise<CatId[]>;
  /** F032 Phase C: Get participants sorted by activity (lastMessageAt desc) */
  getParticipantsWithActivity(threadId: string): ThreadParticipantActivity[] | Promise<ThreadParticipantActivity[]>;
  /** F032 P1-2 fix: Update participant activity on every message (not just join) */
  updateParticipantActivity(threadId: string, catId: CatId, healthy?: boolean): void | Promise<void>;
  updateTitle(threadId: string, title: string): void | Promise<void>;
  /** ISSUE-16: backfill projectPath for threads created before the fix */
  updateProjectPath(threadId: string, projectPath: string): void | Promise<void>;
  updatePin(threadId: string, pinned: boolean): void | Promise<void>;
  updateFavorite(threadId: string, favorited: boolean): void | Promise<void>;
  updateThinkingMode(threadId: string, mode: 'debug' | 'play'): void | Promise<void>;
  updateMentionActionabilityMode(threadId: string, mode: MentionActionabilityMode): void | Promise<void>;
  updatePreferredCats(threadId: string, catIds: CatId[]): void | Promise<void>;
  updatePhase(threadId: string, phase: ThreadPhase): void | Promise<void>;
  linkBacklogItem(threadId: string, backlogItemId: string): void | Promise<void>;
  /**
   * F046 D3: Persist one-shot feedback for suppressed A2A mentions.
   * The next invocation of this cat in this thread should consume and clear it.
   */
  setMentionRoutingFeedback(
    threadId: string,
    catId: CatId,
    feedback: ThreadMentionRoutingFeedback,
  ): void | Promise<void>;
  consumeMentionRoutingFeedback(
    threadId: string,
    catId: CatId,
  ): ThreadMentionRoutingFeedback | null | Promise<ThreadMentionRoutingFeedback | null>;
  /** F042: Set or clear thread routing policy. `null` clears. */
  updateRoutingPolicy(threadId: string, policy: ThreadRoutingPolicyV1 | null): void | Promise<void>;
  /** F065 Phase B: Get thread memory (rolling summary). */
  getThreadMemory(threadId: string): ThreadMemoryV1 | null | Promise<ThreadMemoryV1 | null>;
  /** F065 Phase B: Update thread memory after session seal. */
  updateThreadMemory(threadId: string, memory: ThreadMemoryV1): void | Promise<void>;
  /** F079: Get/update voting state */
  getVotingState(threadId: string): VotingStateV1 | null | Promise<VotingStateV1 | null>;
  updateVotingState(threadId: string, state: VotingStateV1 | null): void | Promise<void>;
  /** Update bubble display overrides (thinking/CLI expand/collapse). */
  updateBubbleDisplay(
    threadId: string,
    field: 'bubbleThinking' | 'bubbleCli',
    value: 'global' | 'expanded' | 'collapsed',
  ): void | Promise<void>;
  /** F092: Update voice companion mode. */
  updateVoiceMode(threadId: string, voiceMode: boolean): void | Promise<void>;
  /** F087: Get/update bootcamp state. */
  updateBootcampState(threadId: string, state: BootcampStateV1 | null): void | Promise<void>;
  /** F088 Phase G: Get/update connector hub state. */
  updateConnectorHubState(threadId: string, state: ConnectorHubStateV1 | null): void | Promise<void>;
  updateLastActive(threadId: string): void | Promise<void>;
  delete(threadId: string): boolean | Promise<boolean>;
  /** F095 Phase D: Soft-delete — mark thread as deleted without removing data. */
  softDelete(threadId: string): boolean | Promise<boolean>;
  /** F095 Phase D: Restore a soft-deleted thread. */
  restore(threadId: string): boolean | Promise<boolean>;
  /** F095 Phase D: List soft-deleted threads (trash bin). */
  listDeleted(userId: string): Thread[] | Promise<Thread[]>;
}

const MAX_THREADS = 100;

/**
 * In-memory thread store with LRU eviction.
 */
export class ThreadStore implements IThreadStore {
  private threads: Map<string, Thread> = new Map();
  /** F032 Phase C: Track participant activity per thread. Key: `${threadId}:${catId}` */
  private participantActivity: Map<
    string,
    { lastMessageAt: number; messageCount: number; lastResponseHealthy?: boolean }
  > = new Map();
  /** F046 D3: one-shot suppressed mention feedback per thread+cat */
  private mentionRoutingFeedback: Map<string, ThreadMentionRoutingFeedback> = new Map();
  private readonly maxThreads: number;

  constructor(options?: { maxThreads?: number }) {
    this.maxThreads = options?.maxThreads ?? MAX_THREADS;
  }

  /** F032 Phase C: Generate activity key */
  private activityKey(threadId: string, catId: CatId): string {
    return `${threadId}:${catId}`;
  }

  private mentionRoutingFeedbackKey(threadId: string, catId: CatId): string {
    return `${threadId}:${catId}`;
  }

  create(userId: string, title?: string, projectPath?: string): Thread {
    this.evictIfNeeded();

    const thread: Thread = {
      id: generateThreadId(),
      projectPath: projectPath ?? 'default',
      title: title ?? null,
      createdBy: userId,
      participants: [],
      lastActiveAt: Date.now(),
      createdAt: Date.now(),
    };

    this.threads.set(thread.id, thread);
    return thread;
  }

  get(threadId: string): Thread | null {
    // Auto-create default thread on first access
    if (threadId === DEFAULT_THREAD_ID && !this.threads.has(DEFAULT_THREAD_ID)) {
      const defaultThread: Thread = {
        id: DEFAULT_THREAD_ID,
        projectPath: 'default',
        title: null,
        createdBy: 'system',
        participants: [],
        lastActiveAt: Date.now(),
        createdAt: Date.now(),
      };
      this.threads.set(DEFAULT_THREAD_ID, defaultThread);
    }

    return this.threads.get(threadId) ?? null;
  }

  list(userId: string): Thread[] {
    const result: Thread[] = [];
    for (const thread of this.threads.values()) {
      if ((thread.createdBy === userId || thread.id === DEFAULT_THREAD_ID) && !thread.deletedAt) {
        result.push(thread);
      }
    }
    // Sort by lastActiveAt descending (most recent first)
    result.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    return result;
  }

  listByProject(userId: string, projectPath: string): Thread[] {
    return this.list(userId).filter((t) => t.projectPath === projectPath);
  }

  addParticipants(threadId: string, catIds: CatId[]): void {
    const thread = this.get(threadId);
    if (!thread) return;

    // Cloud Codex P1 fix: Only add to participants list, do NOT update activity.
    // Activity should only be updated via updateParticipantActivity() after successful message append.
    for (const catId of catIds) {
      if (!thread.participants.includes(catId)) {
        thread.participants.push(catId);
      }
    }
  }

  getParticipants(threadId: string): CatId[] {
    const thread = this.get(threadId);
    return thread?.participants ?? [];
  }

  /** F032 Phase C: Get participants with activity, sorted by lastMessageAt descending */
  getParticipantsWithActivity(threadId: string): ThreadParticipantActivity[] {
    const participants = this.getParticipants(threadId);
    const result: ThreadParticipantActivity[] = participants.map((catId) => {
      const key = this.activityKey(threadId, catId);
      const activity = this.participantActivity.get(key);
      return {
        catId,
        lastMessageAt: activity?.lastMessageAt ?? 0,
        messageCount: activity?.messageCount ?? 0,
        lastResponseHealthy: activity?.lastResponseHealthy,
      };
    });
    // Sort by lastMessageAt descending (most recent first)
    result.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
    return result;
  }

  /** F032 P1-2 fix: Update participant activity on every message */
  updateParticipantActivity(threadId: string, catId: CatId, healthy?: boolean): void {
    const thread = this.get(threadId);
    if (!thread) return;

    // Ensure cat is in participants list
    if (!thread.participants.includes(catId)) {
      thread.participants.push(catId);
    }

    // Update activity timestamp and increment count
    const key = this.activityKey(threadId, catId);
    const existing = this.participantActivity.get(key);
    this.participantActivity.set(key, {
      lastMessageAt: Date.now(),
      messageCount: (existing?.messageCount ?? 0) + 1,
      lastResponseHealthy: healthy ?? true,
    });
  }

  updateTitle(threadId: string, title: string): void {
    const thread = this.get(threadId);
    if (thread) thread.title = title;
  }

  updateProjectPath(threadId: string, projectPath: string): void {
    const thread = this.get(threadId);
    if (thread) thread.projectPath = projectPath;
  }

  updatePin(threadId: string, pinned: boolean): void {
    const thread = this.get(threadId);
    if (thread) {
      thread.pinned = pinned;
      thread.pinnedAt = pinned ? Date.now() : null;
    }
  }

  updateFavorite(threadId: string, favorited: boolean): void {
    const thread = this.get(threadId);
    if (thread) {
      thread.favorited = favorited;
      thread.favoritedAt = favorited ? Date.now() : null;
    }
  }

  updateThinkingMode(threadId: string, mode: 'debug' | 'play'): void {
    const thread = this.get(threadId);
    if (thread) thread.thinkingMode = mode;
  }

  updateMentionActionabilityMode(threadId: string, mode: MentionActionabilityMode): void {
    const thread = this.get(threadId);
    if (!thread) return;
    // strict is default behavior, so clear explicit override to preserve backwards compatibility.
    if (mode === 'strict') {
      delete thread.mentionActionabilityMode;
      return;
    }
    thread.mentionActionabilityMode = mode;
  }

  updatePreferredCats(threadId: string, catIds: CatId[]): void {
    const thread = this.get(threadId);
    if (!thread) return;
    // R5 fix: dedupe at write time to prevent duplicate invocations
    const unique = [...new Set(catIds)];
    if (unique.length > 0) {
      thread.preferredCats = unique;
    } else {
      delete thread.preferredCats;
    }
  }

  updatePhase(threadId: string, phase: ThreadPhase): void {
    const thread = this.get(threadId);
    if (thread) thread.phase = phase;
  }

  linkBacklogItem(threadId: string, backlogItemId: string): void {
    const thread = this.get(threadId);
    if (thread) thread.backlogItemId = backlogItemId;
  }

  setMentionRoutingFeedback(threadId: string, catId: CatId, feedback: ThreadMentionRoutingFeedback): void {
    const key = this.mentionRoutingFeedbackKey(threadId, catId);
    const sourceMessage = feedback.sourceMessageId ? { sourceMessageId: feedback.sourceMessageId } : {};
    this.mentionRoutingFeedback.set(key, {
      ...sourceMessage,
      sourceTimestamp: feedback.sourceTimestamp,
      items: [...feedback.items],
    });
  }

  consumeMentionRoutingFeedback(threadId: string, catId: CatId): ThreadMentionRoutingFeedback | null {
    const key = this.mentionRoutingFeedbackKey(threadId, catId);
    const feedback = this.mentionRoutingFeedback.get(key);
    if (!feedback) return null;
    this.mentionRoutingFeedback.delete(key);
    const sourceMessage = feedback.sourceMessageId ? { sourceMessageId: feedback.sourceMessageId } : {};
    return {
      ...sourceMessage,
      sourceTimestamp: feedback.sourceTimestamp,
      items: [...feedback.items],
    };
  }

  updateRoutingPolicy(threadId: string, policy: ThreadRoutingPolicyV1 | null): void {
    const thread = this.get(threadId);
    if (!thread) return;

    // Normalize: null or empty scopes clears policy.
    const scopes = policy?.scopes;
    const hasScopes = scopes && Object.keys(scopes).length > 0;
    if (!policy || policy.v !== 1 || !hasScopes) {
      delete thread.routingPolicy;
      return;
    }

    thread.routingPolicy = policy;
  }

  getThreadMemory(threadId: string): ThreadMemoryV1 | null {
    const thread = this.get(threadId);
    return thread?.threadMemory ?? null;
  }

  updateThreadMemory(threadId: string, memory: ThreadMemoryV1): void {
    const thread = this.get(threadId);
    if (thread) thread.threadMemory = memory;
  }

  getVotingState(threadId: string): VotingStateV1 | null {
    const thread = this.get(threadId);
    return thread?.votingState ?? null;
  }

  updateVotingState(threadId: string, state: VotingStateV1 | null): void {
    const thread = this.get(threadId);
    if (!thread) return;
    if (state === null) {
      delete thread.votingState;
    } else {
      thread.votingState = state;
    }
  }

  updateBubbleDisplay(
    threadId: string,
    field: 'bubbleThinking' | 'bubbleCli',
    value: 'global' | 'expanded' | 'collapsed',
  ): void {
    const thread = this.get(threadId);
    if (!thread) return;
    if (value === 'global') {
      delete thread[field];
    } else {
      thread[field] = value;
    }
  }

  updateVoiceMode(threadId: string, voiceMode: boolean): void {
    const thread = this.get(threadId);
    if (!thread) return;
    if (voiceMode) {
      thread.voiceMode = true;
    } else {
      delete thread.voiceMode;
    }
  }

  updateBootcampState(threadId: string, state: BootcampStateV1 | null): void {
    const thread = this.get(threadId);
    if (!thread) return;
    if (state === null) {
      delete thread.bootcampState;
    } else {
      thread.bootcampState = state;
    }
  }

  updateConnectorHubState(threadId: string, state: ConnectorHubStateV1 | null): void {
    const thread = this.get(threadId);
    if (!thread) return;
    if (state === null) {
      delete thread.connectorHubState;
    } else {
      thread.connectorHubState = state;
    }
  }

  updateLastActive(threadId: string): void {
    const thread = this.get(threadId);
    if (thread) {
      thread.lastActiveAt = Date.now();
      // Move to end of Map for LRU (delete + re-insert)
      this.threads.delete(threadId);
      this.threads.set(threadId, thread);
    }
  }

  delete(threadId: string): boolean {
    if (threadId === DEFAULT_THREAD_ID) return false; // Cannot delete default
    // Cloud Codex R3 P2 fix: Clean up activity entries to prevent memory leak
    this.clearActivityForThread(threadId);
    this.clearMentionRoutingFeedbackForThread(threadId);
    return this.threads.delete(threadId);
  }

  /** F095 Phase D: Soft-delete — mark thread as deleted. */
  softDelete(threadId: string): boolean {
    if (threadId === DEFAULT_THREAD_ID) return false;
    const thread = this.threads.get(threadId);
    if (!thread || thread.deletedAt) return false;
    thread.deletedAt = Date.now();
    return true;
  }

  /** F095 Phase D: Restore a soft-deleted thread. */
  restore(threadId: string): boolean {
    const thread = this.threads.get(threadId);
    if (!thread || !thread.deletedAt) return false;
    thread.deletedAt = null;
    return true;
  }

  /** F095 Phase D: List soft-deleted threads (trash bin). */
  listDeleted(userId: string): Thread[] {
    const result: Thread[] = [];
    for (const thread of this.threads.values()) {
      if (thread.createdBy === userId && thread.deletedAt) {
        result.push(thread);
      }
    }
    result.sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0));
    return result;
  }

  /** Cloud Codex R3 P2 fix: Remove all activity entries for a thread */
  private clearActivityForThread(threadId: string): void {
    const prefix = `${threadId}:`;
    for (const key of this.participantActivity.keys()) {
      if (key.startsWith(prefix)) {
        this.participantActivity.delete(key);
      }
    }
  }

  private clearMentionRoutingFeedbackForThread(threadId: string): void {
    const prefix = `${threadId}:`;
    for (const key of this.mentionRoutingFeedback.keys()) {
      if (key.startsWith(prefix)) {
        this.mentionRoutingFeedback.delete(key);
      }
    }
  }

  /** Current thread count (for testing) */
  get size(): number {
    return this.threads.size;
  }

  private evictIfNeeded(): void {
    while (this.threads.size >= this.maxThreads) {
      // Find the oldest non-default key (Map preserves insertion order)
      let evicted = false;
      for (const key of this.threads.keys()) {
        if (key !== DEFAULT_THREAD_ID) {
          // Cloud Codex R3 P2 fix: Clean up activity before evicting
          this.clearActivityForThread(key);
          this.clearMentionRoutingFeedbackForThread(key);
          this.threads.delete(key);
          evicted = true;
          break;
        }
      }
      // Only default thread left — cannot evict further
      if (!evicted) break;
    }
  }
}
