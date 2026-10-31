/**
 * F252 Phase C — BFF pure function: FeatTrajectoryProjection → FeatureStoryRenderingDTO
 *
 * 消费 F233 单一真相源（KD-5），投影为渲染友好的 DTO：
 * - 泳道：每个出现在 entries 中的 thread 一条
 * - 因果边：thread_split / thread_merge 的跨泳道箭头
 * - 里程碑：branch_merged_to_main / closed 等全局叙事节拍
 *
 * 纯函数，零 IO——所有外部数据（projection + threadMeta）由调用者注入。
 */

import type {
  CausalEdgeDTO,
  FeatTrajectoryEntry,
  FeatTrajectoryKind,
  FeatTrajectoryProjection,
  FeatureStoryRenderingDTO,
  SwimlaneDTO,
  TimelineMilestoneDTO,
  TrajectoryMarkerDTO,
} from '@cat-cafe/shared';

// ============================================================================
// Thread metadata input
// ============================================================================

export interface ThreadMeta {
  threadId: string;
  name: string;
  participants: string[];
}

// ============================================================================
// Milestone-worthy kinds (全局叙事节拍)
// ============================================================================

const MILESTONE_KINDS: Set<FeatTrajectoryKind> = new Set([
  'launched',
  'phase_transition',
  'branch_merged_to_main',
  'verdict',
  'closed',
  'reopened',
]);

// ============================================================================
// Causal edge extraction
// ============================================================================

const CAUSAL_EDGE_KINDS = new Set(['thread_split', 'thread_merge', 'branch_merged_to_main']);

// ============================================================================
// Main builder
// ============================================================================

export function buildFeatureStoryRendering(
  projection: FeatTrajectoryProjection,
  threadMeta: Map<string, ThreadMeta>,
  title: string,
): FeatureStoryRenderingDTO {
  const { featId, entries } = projection;

  if (entries.length === 0) {
    return {
      storyId: `feat:${featId}`,
      featId,
      title,
      timeRange: { start: 0, end: 0 },
      lanes: [],
      edges: [],
      milestones: [],
    };
  }

  // 1. Discover all threads referenced by entries
  const threadParticipants = new Map<string, Set<string>>(); // threadId → Set<catId>
  const threadMarkers = new Map<string, TrajectoryMarkerDTO[]>(); // threadId → markers
  // Track threads introduced by ownership-establishing sources (thread_split,
  // git-ref-snapshot).  Only these definitively prove a thread belongs to this
  // feature.  thread_merge entries are NOT used for ownership — when
  // CrossPostCollector falls back to the target feature (source thread has no
  // feat association), the source thread is external and the target is owned,
  // so blindly marking the source as owned would reverse the ownership for
  // incoming cross-posts (Cloud R3 P2-1 fix).
  const ownedThreadIds = new Set<string>();

  for (const entry of entries) {
    const threadIds = extractThreadIds(entry);
    const catId = extractCatId(entry);
    const primaryThreadId = extractPrimaryThreadId(entry);

    // Track ownership: ONLY thread_split and git-ref-snapshot establish it.
    // thread_merge is deliberately excluded — see comment above.
    if (entry.kind === 'thread_split') {
      const payload = entry.payload;
      if (payload.parentThreadId) ownedThreadIds.add(payload.parentThreadId as string);
      if (payload.childThreadId) ownedThreadIds.add(payload.childThreadId as string);
    } else if (entry.source === 'git-ref-snapshot' && entry.payload.snapshot) {
      const snapshot = entry.payload.snapshot as Record<string, unknown>;
      if (Array.isArray(snapshot.associatedThreadIds)) {
        for (const tid of snapshot.associatedThreadIds) ownedThreadIds.add(tid as string);
      }
    }

    // Register threads
    for (const tid of threadIds) {
      if (!threadParticipants.has(tid)) {
        threadParticipants.set(tid, new Set());
      }
      if (catId) {
        threadParticipants.get(tid)!.add(catId);
      }
    }

    // Place marker in the primary thread's lane
    if (primaryThreadId) {
      if (!threadMarkers.has(primaryThreadId)) {
        threadMarkers.set(primaryThreadId, []);
      }
      threadMarkers.get(primaryThreadId)!.push(entryToMarker(entry));
    }
  }

  // 2. Build lanes (mark guest lanes for AC-E6 cross-feature detection)
  const lanes: SwimlaneDTO[] = [];
  for (const [threadId, participants] of threadParticipants) {
    const meta = threadMeta.get(threadId);
    const isGuest = !ownedThreadIds.has(threadId);
    lanes.push({
      threadId,
      threadName: meta?.name ?? threadId,
      participants: [...participants].sort(),
      markers: (threadMarkers.get(threadId) ?? []).sort((a, b) => a.at - b.at),
      ...(isGuest ? { guest: true } : {}),
    });
  }
  // Sort lanes by first marker timestamp (earliest activity first)
  lanes.sort((a, b) => {
    const aFirst = a.markers[0]?.at ?? Infinity;
    const bFirst = b.markers[0]?.at ?? Infinity;
    return aFirst - bFirst;
  });

  // 3. Extract causal edges
  const edges: CausalEdgeDTO[] = [];
  for (const entry of entries) {
    const edge = entryCausalEdge(entry);
    if (edge) edges.push(edge);
  }

  // 4. Extract milestones
  const milestones: TimelineMilestoneDTO[] = [];
  for (const entry of entries) {
    if (MILESTONE_KINDS.has(entry.kind)) {
      milestones.push({
        at: entry.at,
        kind: entry.kind,
        label: milestoneLabel(entry),
        entryId: entry.entryId,
      });
    }
  }
  milestones.sort((a, b) => a.at - b.at);

  // 5. Compute time range
  const times = entries.map((e) => e.at);
  const timeRange = { start: Math.min(...times), end: Math.max(...times) };

  return {
    storyId: `feat:${featId}`,
    featId,
    title,
    timeRange,
    lanes,
    edges,
    milestones,
  };
}

// ============================================================================
// Helpers
// ============================================================================

/** Extract all thread IDs referenced by an entry (from payload). */
function extractThreadIds(entry: FeatTrajectoryEntry): string[] {
  const payload = entry.payload;
  const ids: string[] = [];

  // thread_split: parent + child
  if (entry.kind === 'thread_split') {
    if (payload.parentThreadId) ids.push(payload.parentThreadId as string);
    if (payload.childThreadId) ids.push(payload.childThreadId as string);
  }
  // thread_merge: source + target
  else if (entry.kind === 'thread_merge') {
    if (payload.sourceThreadId) ids.push(payload.sourceThreadId as string);
    if (payload.targetThreadId) ids.push(payload.targetThreadId as string);
  }
  // git-ref: associatedThreadIds from snapshot
  else if (entry.source === 'git-ref-snapshot' && payload.snapshot) {
    const snapshot = payload.snapshot as Record<string, unknown>;
    if (Array.isArray(snapshot.associatedThreadIds)) {
      ids.push(...(snapshot.associatedThreadIds as string[]));
    }
  }

  return ids;
}

/** Extract the primary thread where this entry's marker should appear. */
function extractPrimaryThreadId(entry: FeatTrajectoryEntry): string | null {
  const payload = entry.payload;

  if (entry.kind === 'thread_split') {
    return (payload.parentThreadId as string) ?? null;
  }
  if (entry.kind === 'thread_merge') {
    return (payload.sourceThreadId as string) ?? null;
  }
  if (entry.source === 'git-ref-snapshot' && payload.snapshot) {
    const snapshot = payload.snapshot as Record<string, unknown>;
    const threadIds = snapshot.associatedThreadIds as string[] | undefined;
    return threadIds?.[0] ?? null;
  }
  return null;
}

/** Extract catId from entry payload. */
function extractCatId(entry: FeatTrajectoryEntry): string | null {
  const payload = entry.payload;

  if (payload.catId) return payload.catId as string;
  if (entry.source === 'git-ref-snapshot' && payload.snapshot) {
    return ((payload.snapshot as Record<string, unknown>).authorIdentity as string) ?? null;
  }
  return null;
}

/** Convert entry to a marker DTO for swimlane placement. */
function entryToMarker(entry: FeatTrajectoryEntry): TrajectoryMarkerDTO {
  return {
    entryId: entry.entryId,
    at: entry.at,
    kind: entry.kind,
    label: markerLabel(entry),
    details: entry.payload,
  };
}

/** Generate a human-readable label for a trajectory marker. */
function markerLabel(entry: FeatTrajectoryEntry): string {
  const payload = entry.payload;
  switch (entry.kind) {
    case 'thread_split':
      return `Thread split by ${payload.catId ?? 'unknown'}`;
    case 'thread_merge':
      return `Cross-post by ${payload.catId ?? 'unknown'}`;
    case 'branch_pushed': {
      const snap = payload.snapshot as Record<string, unknown> | undefined;
      return `Push ${(snap?.headCommitSha as string)?.slice(0, 7) ?? ''}`;
    }
    case 'pr_opened': {
      const snap = payload.snapshot as Record<string, unknown> | undefined;
      return `PR #${snap?.prNumber ?? '?'} opened`;
    }
    case 'branch_merged_to_main': {
      const snap = payload.snapshot as Record<string, unknown> | undefined;
      return `PR #${snap?.prNumber ?? '?'} merged`;
    }
    case 'branch_stale_unmerged':
      return 'Stale branch';
    case 'launched':
      return 'Feature launched';
    case 'closed':
      return 'Feature closed';
    case 'verdict':
      return 'Verdict';
    case 'phase_transition':
      return 'Phase transition';
    case 'reopened':
      return 'Reopened';
    default:
      return entry.kind;
  }
}

/** Extract causal edge from an entry if applicable. */
function entryCausalEdge(entry: FeatTrajectoryEntry): CausalEdgeDTO | null {
  if (!CAUSAL_EDGE_KINDS.has(entry.kind)) return null;

  const payload = entry.payload;

  if (entry.kind === 'thread_split') {
    const parentId = payload.parentThreadId as string | undefined;
    const childId = payload.childThreadId as string | undefined;
    if (!parentId || !childId) return null;

    return {
      id: `edge:${entry.entryId}`,
      kind: 'thread_split',
      from: { threadId: parentId, time: entry.at },
      to: { threadId: childId, time: entry.at },
      label: `Thread split by ${payload.catId ?? 'unknown'}`,
      confidence: 'high', // Proposal store is authoritative
    };
  }

  if (entry.kind === 'thread_merge') {
    const sourceId = payload.sourceThreadId as string | undefined;
    const targetId = payload.targetThreadId as string | undefined;
    if (!sourceId || !targetId) return null;

    return {
      id: `edge:${entry.entryId}`,
      kind: 'thread_merge',
      from: { threadId: sourceId, time: entry.at },
      to: { threadId: targetId, time: entry.at },
      label: `Cross-post by ${payload.catId ?? 'unknown'}`,
      confidence: 'high', // Message store is authoritative
    };
  }

  // branch_merged_to_main — not a cross-thread edge in the same way,
  // but could become one if we associate with specific threads.
  // For now, only emit edge if we can trace both threads.
  return null;
}

/** Generate milestone label. */
function milestoneLabel(entry: FeatTrajectoryEntry): string {
  return markerLabel(entry);
}
