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
  /** F148 Phase H: Deterministic file/PR artifacts from session seal (max 5) */
  recentArtifacts?: Array<{
    type: string;
    ref: string;
    label: string;
    updatedAt: number;
    updatedBy: string;
    ops?: string[];
  }>;
}

export type ExternalRuntimeAnchorRuntime = 'antigravity-desktop';

export interface ExternalRuntimeAnchorStateV1 {
  v: 1;
  runtime: ExternalRuntimeAnchorRuntime;
  userId: string;
  createdAt: number;
}

export function buildExternalRuntimeAnchorThreadId(runtime: ExternalRuntimeAnchorRuntime, userId: string): string {
  return `external-runtime:${runtime}:${userId}`;
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
  /** F087: operator Bootcamp onboarding state. */
  bootcampState?: BootcampStateV1;
  /** F128: Parent thread ID for orchestration tracking (sub-threads report back here). */
  parentThreadId?: string;
  /** F128: Proposal that led to this thread being created (audit metadata). */
  createdFromProposalId?: string;
  /** F128: Source thread the proposal was raised in (audit metadata). */
  sourceThreadId?: string;
  /** F128: User who approved the proposal (audit metadata). */
  approvedBy?: string;
  /** F128: Unix ms when the proposal was approved (audit metadata). */
  approvedAt?: number;
  /** F171: First-Run Quest onboarding state. */
  firstRunQuestState?: FirstRunQuestStateV1;
  /** F192 livefix: System thread kind — determines sidebar "系统" section visibility.
   *  connector_hub = IM Hub thread, eval_domain = harness eval domain thread. */
  systemKind?: 'connector_hub' | 'eval_domain';
  /** F088 Phase G: Connector Hub thread state — marks this thread as an IM Hub for command isolation. */
  connectorHubState?: ConnectorHubStateV1;
  /** F211 Phase B: Hidden per-user runtime anchor for orphan external runtime sessions. */
  externalRuntimeAnchorState?: ExternalRuntimeAnchorStateV1;
  /** F168: Auto-switch workspace panel when this thread is opened. */
  preferredWorkspaceMode?: 'dev' | 'recall' | 'schedule' | 'tasks' | 'community' | 'artifacts';
  /** F187: User-defined label IDs for thread categorization. */
  labels?: string[];
  /** F229: Thread kind marker. 'concierge' = 专属前台猫载体（per-user，sidebar 默认隐藏）。
   *  undefined/absence = 普通 thread。 */
  threadKind?: 'concierge';
  /** #813: Per-cat pending continuation capsule — written at session seal,
   *  consumed at next invocation start. Passive/lazy session renewal. */
  pendingContinuation?: Record<string, PendingContinuationEntry>;
  /** #836: Per-cat session strategy override at thread member level.
   *  'resume' (default) = normal session continuation / bootstrap / continuation capsule.
   *  'reborn' = force new session every invocation, skip bootstrap digest, skip continuation. */
  memberSessionStrategy?: Record<string, 'resume' | 'reborn'>;
}

/** #813: Pending continuation state per cat. Written by seal, consumed at next invocation. */
export interface PendingContinuationEntry {
  /** The serialized continuation capsule (CollaborationContinuityCapsuleV1). */
  capsule: Record<string, unknown>;
  /** Unix ms when the seal wrote this entry. */
  createdAt: number;
}

/**
 * F128: Audit metadata written to a thread when it is created from an approved proposal.
 */
export interface ThreadProposalAudit {
  createdFromProposalId: string;
  sourceThreadId: string;
  approvedBy: string;
  approvedAt: number;
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

/** F087: Bootcamp phase for operator onboarding (F171 v2 flow) */
export type BootcampPhase =
  | 'phase-1-intro'
  | 'phase-2-env-check'
  | 'phase-3-config-help'
  | 'phase-4-task-select'
  | 'phase-5-kickoff'
  | 'phase-6-design'
  | 'phase-7-dev'
  | 'phase-7.5-add-teammate'
  | 'phase-8-collab'
  | 'phase-9-complete'
  | 'phase-10-retro'
  | 'phase-11-farewell';

/** F171: Sub-step for add-teammate console guide overlay */
export type BootcampGuideStep = 'preview-result' | 'open-hub' | 'click-add-member' | 'fill-form' | 'done';

export interface BootcampStateV1 {
  v: 1;
  phase: BootcampPhase;
  leadCat?: CatId;
  selectedTaskId?: string;
  /** F171: sub-step for add-teammate console guide overlay */
  guideStep?: BootcampGuideStep | null;
  envCheck?: Record<string, { ok: boolean; version?: string; note?: string }>;
  advancedFeatures?: Record<string, 'available' | 'unavailable' | 'skipped'>;
  startedAt: number;
  completedAt?: number;
}

/** F171: First-Run Quest phase */
export type FirstRunQuestPhase =
  | 'quest-0-welcome'
  | 'quest-1-create-first-cat'
  | 'quest-2-cat-intro'
  | 'quest-3-task-select'
  | 'quest-4-task-running'
  | 'quest-5-error-encountered'
  | 'quest-6-second-cat-prompt'
  | 'quest-7-second-cat-created'
  | 'quest-8-collaboration-demo'
  | 'quest-9-completion';

/** F171: First-Run Quest state stored in thread metadata */
export interface FirstRunQuestStateV1 {
  v: 1;
  phase: FirstRunQuestPhase;
  startedAt: number;
  completedAt?: number;
  firstCatId?: string;
  firstCatName?: string;
  secondCatId?: string;
  secondCatName?: string;
  selectedTaskId?: string;
  errorDetected?: boolean;
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

/** F187: A user-defined label for categorizing threads. */
export interface ThreadLabel {
  id: string;
  name: string;
  color: string;
  sortOrder: number;
  createdBy: string;
  createdAt: number;
}

/** F187: Store for thread label CRUD operations. */
export interface ILabelStore {
  create(label: ThreadLabel): Promise<ThreadLabel>;
  list(userId: string): Promise<ThreadLabel[]>;
  get(id: string): Promise<ThreadLabel | null>;
  update(
    id: string,
    userId: string,
    fields: Partial<Pick<ThreadLabel, 'name' | 'color' | 'sortOrder'>>,
  ): Promise<ThreadLabel | null>;
  delete(id: string, userId: string): Promise<boolean>;
}

/**
 * Common interface for thread stores (in-memory and future Redis).
 */
export interface IThreadStore {
  create(
    userId: string,
    title?: string,
    projectPath?: string,
    parentThreadId?: string,
    proposalAudit?: ThreadProposalAudit,
  ): Thread | Promise<Thread>;
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
  /** F171: Get/update first-run quest state. */
  updateFirstRunQuestState(threadId: string, state: FirstRunQuestStateV1 | null): void | Promise<void>;
  /** F192 livefix: Set/clear system thread kind for sidebar "系统" section visibility. */
  updateSystemKind(threadId: string, kind: 'connector_hub' | 'eval_domain' | null): void | Promise<void>;
  /** F088 Phase G: Get/update connector hub state. */
  updateConnectorHubState(threadId: string, state: ConnectorHubStateV1 | null): void | Promise<void>;
  updatePreferredWorkspaceMode(
    threadId: string,
    mode: 'dev' | 'recall' | 'schedule' | 'tasks' | 'community' | 'artifacts' | null,
  ): void | Promise<void>;
  /** F187: Update thread labels (replaces entire array). */
  updateLabels(threadId: string, labelIds: string[]): void | Promise<void>;
  /** #836: Update per-cat session strategy for a thread member. `null` clears. */
  updateMemberSessionStrategy(
    threadId: string,
    catId: string,
    strategy: 'resume' | 'reborn' | null,
  ): void | Promise<void>;
  /** F224: Coordinator-facing strategy read. Undefined means default resume. */
  getMemberSessionStrategy?(
    threadId: string,
    catId: string,
    userId: string,
  ): 'resume' | 'reborn' | undefined | Promise<'resume' | 'reborn' | undefined>;
  /** #836: Check if a cat uses reborn session strategy in this thread.
   *  Must be used instead of reading thread.memberSessionStrategy directly,
   *  because Redis stores strategy in separate hash fields (memberSS:<catId>)
   *  that are NOT hydrated by get().
   *  Optional for backward compat with test mocks — absent = never reborn. */
  isRebornSession?(threadId: string, catId: string): boolean | Promise<boolean>;
  /** #813: Write pending continuation state for a cat+user (passive seal). */
  setPendingContinuation(
    threadId: string,
    catId: string,
    userId: string,
    entry: PendingContinuationEntry,
  ): void | Promise<void>;
  /** #813: Consume (read + delete) pending continuation for a cat+user. Returns null if none. */
  consumePendingContinuation(
    threadId: string,
    catId: string,
    userId: string,
  ): PendingContinuationEntry | null | Promise<PendingContinuationEntry | null>;
  /**
   * Ensure a thread with a specific ID exists. If it doesn't exist, create it
   * with the given title and createdBy='system'. If it already exists, no-op.
   * Returns the thread (existing or newly created).
   */
  ensureThread(threadId: string, title: string): Thread | Promise<Thread>;
  ensureExternalRuntimeAnchorThread(runtime: ExternalRuntimeAnchorRuntime, userId: string): Thread | Promise<Thread>;
  updateLastActive(threadId: string): void | Promise<void>;
  delete(threadId: string): boolean | Promise<boolean>;
  /** F128: List child threads that have this thread as parentThreadId. */
  getChildThreads(parentThreadId: string): Thread[] | Promise<Thread[]>;
  /** F095 Phase D: Soft-delete — mark thread as deleted without removing data. */
  softDelete(threadId: string): boolean | Promise<boolean>;
  /** F095 Phase D: Restore a soft-deleted thread. */
  restore(threadId: string): boolean | Promise<boolean>;
  /** F095 Phase D: List soft-deleted threads (trash bin). */
  listDeleted(userId: string): Thread[] | Promise<Thread[]>;
  /**
   * F192 cloud-review P1: Add an existing thread to a user's thread list so it appears in their sidebar.
   * Used for system threads (eval domain, connector hub) created by ensureThread() which
   * skips user-list indexing. Idempotent — re-indexing an already-visible thread is a no-op.
   */
  indexForUser(threadId: string, userId: string): void | Promise<void>;
  /** F229: Set or clear threadKind marker. 'concierge' = 专属前台猫载体（sidebar 默认隐藏）。null 清除。 */
  updateThreadKind(threadId: string, kind: 'concierge' | null): void | Promise<void>;
  /** Repair sparse/missing per-user thread indexes from authoritative thread detail hashes. */
  repairIndex?(userId?: string): Promise<{ repairedUsers: number; repairedMembers: number }>;
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
  /** F192 cloud P1: extra user→threadId index for system threads surfaced via indexForUser */
  private userThreadIndex: Map<string, Set<string>> = new Map();
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

  create(
    userId: string,
    title?: string,
    projectPath?: string,
    parentThreadId?: string,
    proposalAudit?: ThreadProposalAudit,
  ): Thread {
    this.evictIfNeeded();

    const thread: Thread = {
      id: generateThreadId(),
      projectPath: projectPath ?? 'default',
      title: title ?? null,
      createdBy: userId,
      participants: [],
      lastActiveAt: Date.now(),
      createdAt: Date.now(),
      ...(parentThreadId ? { parentThreadId } : {}),
      ...(proposalAudit
        ? {
            createdFromProposalId: proposalAudit.createdFromProposalId,
            sourceThreadId: proposalAudit.sourceThreadId,
            approvedBy: proposalAudit.approvedBy,
            approvedAt: proposalAudit.approvedAt,
          }
        : {}),
    };

    this.threads.set(thread.id, thread);
    return thread;
  }

  ensureThread(threadId: string, title: string): Thread {
    const existing = this.threads.get(threadId);
    if (existing) return existing;

    this.evictIfNeeded();

    const now = Date.now();
    const thread: Thread = {
      id: threadId,
      projectPath: 'default',
      title,
      createdBy: 'system',
      participants: [],
      lastActiveAt: now,
      createdAt: now,
    };
    this.threads.set(threadId, thread);
    return thread;
  }

  ensureExternalRuntimeAnchorThread(runtime: ExternalRuntimeAnchorRuntime, userId: string): Thread {
    const threadId = buildExternalRuntimeAnchorThreadId(runtime, userId);
    const existing = this.threads.get(threadId);
    if (existing) return existing;

    this.evictIfNeeded();

    const now = Date.now();
    const thread: Thread = {
      id: threadId,
      projectPath: `external-runtime:${runtime}`,
      title: `External runtime: ${runtime}`,
      createdBy: 'system',
      participants: [],
      lastActiveAt: now,
      createdAt: now,
      externalRuntimeAnchorState: {
        v: 1,
        runtime,
        userId,
        createdAt: now,
      },
    };
    this.threads.set(threadId, thread);
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
    const indexed = this.userThreadIndex.get(userId);
    const result: Thread[] = [];
    for (const thread of this.threads.values()) {
      if (thread.externalRuntimeAnchorState) continue;
      const ownedOrDefault = thread.createdBy === userId || thread.id === DEFAULT_THREAD_ID;
      const userIndexed = indexed?.has(thread.id) ?? false;
      if ((ownedOrDefault || userIndexed) && !thread.deletedAt) {
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

  updateFirstRunQuestState(threadId: string, state: FirstRunQuestStateV1 | null): void {
    const thread = this.get(threadId);
    if (!thread) return;
    if (state === null) {
      delete thread.firstRunQuestState;
    } else {
      thread.firstRunQuestState = state;
    }
  }

  updateSystemKind(threadId: string, kind: 'connector_hub' | 'eval_domain' | null): void {
    const thread = this.get(threadId);
    if (!thread) return;
    if (kind === null) {
      delete thread.systemKind;
    } else {
      thread.systemKind = kind;
    }
  }

  /** F229: Set or clear threadKind marker for concierge thread. */
  updateThreadKind(threadId: string, kind: 'concierge' | null): void {
    const thread = this.get(threadId);
    if (!thread) return;
    if (kind === null) {
      delete thread.threadKind;
    } else {
      thread.threadKind = kind;
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

  updatePreferredWorkspaceMode(
    threadId: string,
    mode: 'dev' | 'recall' | 'schedule' | 'tasks' | 'community' | 'artifacts' | null,
  ): void {
    const thread = this.get(threadId);
    if (!thread) return;
    if (mode === null) {
      delete thread.preferredWorkspaceMode;
    } else {
      thread.preferredWorkspaceMode = mode;
    }
  }

  updateLabels(threadId: string, labelIds: string[]): void {
    const thread = this.get(threadId);
    if (thread) thread.labels = labelIds;
  }

  updateMemberSessionStrategy(threadId: string, catId: string, strategy: 'resume' | 'reborn' | null): void {
    const thread = this.get(threadId);
    if (!thread) return;
    if (strategy === null || strategy === 'resume') {
      // null or default: remove override
      if (thread.memberSessionStrategy) {
        delete thread.memberSessionStrategy[catId];
        if (Object.keys(thread.memberSessionStrategy).length === 0) {
          delete thread.memberSessionStrategy;
        }
      }
    } else {
      if (!thread.memberSessionStrategy) thread.memberSessionStrategy = {};
      thread.memberSessionStrategy[catId] = strategy;
      // #836 P2: Clear stale pending continuations when switching to reborn.
      // Capsules sealed before the reborn period contain pre-reborn session
      // context; if reborn is later cleared back to resume, consuming them
      // would resume from stale state instead of the post-reborn session.
      if (strategy === 'reborn' && thread.pendingContinuation) {
        const prefix = `${catId}:`;
        for (const key of Object.keys(thread.pendingContinuation)) {
          if (key.startsWith(prefix)) {
            delete thread.pendingContinuation[key];
          }
        }
        if (Object.keys(thread.pendingContinuation).length === 0) {
          delete thread.pendingContinuation;
        }
      }
    }
  }

  /** #836: Check if cat uses reborn strategy in this thread. */
  getMemberSessionStrategy(threadId: string, catId: string, _userId: string): 'resume' | 'reborn' | undefined {
    const thread = this.get(threadId);
    return thread?.memberSessionStrategy?.[catId];
  }

  isRebornSession(threadId: string, catId: string): boolean {
    const thread = this.get(threadId);
    return thread?.memberSessionStrategy?.[catId] === 'reborn';
  }

  setPendingContinuation(threadId: string, catId: string, userId: string, entry: PendingContinuationEntry): void {
    const thread = this.get(threadId);
    if (!thread) return;
    if (!thread.pendingContinuation) thread.pendingContinuation = {};
    const scopeKey = `${catId}:${userId}`;
    thread.pendingContinuation[scopeKey] = entry;
  }

  consumePendingContinuation(threadId: string, catId: string, userId: string): PendingContinuationEntry | null {
    const thread = this.get(threadId);
    const scopeKey = `${catId}:${userId}`;
    if (!thread?.pendingContinuation?.[scopeKey]) return null;
    const entry = thread.pendingContinuation[scopeKey]!;
    delete thread.pendingContinuation[scopeKey];
    // Clean up empty container
    if (Object.keys(thread.pendingContinuation).length === 0) {
      delete thread.pendingContinuation;
    }
    return entry;
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

  /** F128: List child threads that have this thread as parentThreadId. */
  getChildThreads(parentThreadId: string): Thread[] {
    const children: Thread[] = [];
    for (const thread of this.threads.values()) {
      if (thread.parentThreadId === parentThreadId && !thread.deletedAt) {
        children.push(thread);
      }
    }
    return children.sort((a, b) => a.createdAt - b.createdAt);
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
  indexForUser(threadId: string, userId: string): void {
    const thread = this.threads.get(threadId);
    if (!thread) return;
    let indexed = this.userThreadIndex.get(userId);
    if (!indexed) {
      indexed = new Set();
      this.userThreadIndex.set(userId, indexed);
    }
    indexed.add(threadId);
  }

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
