import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { IInvocationRecordStore } from '../../cats/services/stores/ports/InvocationRecordStore.js';
import type { IThreadStore } from '../../cats/services/stores/ports/ThreadStore.js';
import type { ITurnExecutionStore } from '../../cats/services/stores/ports/TurnExecutionStore.js';
import { resolveCanonicalTasteRoot, type TasteRepository } from '../../taste/services/TasteRepository.js';
import {
  EXPLICIT_APPROVED_TASTE_SOURCE_ANCHOR_PREFIX,
  EXPLICIT_APPROVED_TASTE_TRIGGERS,
} from '../cue/ExplicitApprovedTasteTriggerCatalog.js';
import { type MemoryCueSourceSummary, MemoryCueSourceSummaryReader } from '../cue/MemoryCueSourceSummaryReader.js';
import { F315_WORKSPACE_READABILITY_TASTE_BUNDLE_V1, tasteTaskBundleAnchor } from '../cue/TasteTaskBundleCatalog.js';
import { TasteMemoryReader, type TasteMemoryVisibility } from './TasteMemoryReader.js';

type Counts = MemoryCueSourceSummary['counts'];
type Latest = MemoryCueSourceSummary['latest'];

interface SearchStats {
  hits: number;
  opened: number;
  unverified: number;
  latest: { threadId: string; recalledAt: number; opened: boolean } | null;
}

interface TasteEntry {
  sourcePath: string;
  visibility: TasteMemoryVisibility;
  dimension: string | null;
  namedDelivery: { trigger: 'eli5' | 'f315_review'; counts: Counts; latest: Latest } | null;
  dimensionHint: { attribution: 'constellation_only'; dimension: string } | null;
  search: SearchStats | null;
}

interface Constellation {
  dimension: string;
  attribution: 'shared_hint';
  hints: Counts;
  latest: Latest;
}

interface PullRecallRow {
  recall_id: string;
  invocation_id: string;
  thread_id: string;
  candidates_json: string;
  consumed_json: string;
  timestamp: number;
}

export interface TasteObservatorySnapshot {
  entries: TasteEntry[];
  constellations: Constellation[];
  coverage: {
    scope: 'verified_invocations_and_owner_threads';
    totalUnverified: number;
    sharedUnknownPolicy: 'excluded';
  };
}

type InvocationOwnership = { kind: 'owned'; threadId: string } | { kind: 'foreign' } | { kind: 'unverified' };

const ZERO_COUNTS = (): Counts => ({ presented: 0, drilled: 0, applied: 0, dismissed: 0 });
const ZERO_SEARCH = (): SearchStats => ({
  hits: 0,
  opened: 0,
  unverified: 0,
  latest: null,
});

function namedTrigger(sourcePath: string): { trigger: 'eli5' | 'f315_review'; anchor: string } | null {
  if (EXPLICIT_APPROVED_TASTE_TRIGGERS.some((trigger) => trigger.sourcePath === sourcePath)) {
    return { trigger: 'eli5', anchor: `${EXPLICIT_APPROVED_TASTE_SOURCE_ANCHOR_PREFIX}${sourcePath}` };
  }
  if (F315_WORKSPACE_READABILITY_TASTE_BUNDLE_V1.sourcePaths.some((path) => path === sourcePath)) {
    return {
      trigger: 'f315_review',
      anchor: tasteTaskBundleAnchor(F315_WORKSPACE_READABILITY_TASTE_BUNDLE_V1.bundleId, sourcePath),
    };
  }
  return null;
}

function parseAnchors(raw: string): Set<string> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed.flatMap((item) =>
        typeof item === 'object' && item !== null && 'anchor' in item && typeof item.anchor === 'string'
          ? [item.anchor]
          : [],
      ),
    );
  } catch {
    return new Set();
  }
}

function searchAnchor(sourcePath: string): string {
  return `doc:${sourcePath.replace(/^docs\//, '').replace(/\.md$/, '')}`;
}

function addCounts(target: Counts, source: Counts): void {
  target.presented += source.presented;
  target.drilled += source.drilled;
  target.applied += source.applied;
  target.dismissed += source.dismissed;
}

async function listSourcePaths(root: string, includePrivate: boolean): Promise<string[]> {
  const directories = includePrivate ? ['docs/taste/vignettes', 'private/taste'] : ['docs/taste/vignettes'];
  const paths: string[] = [];
  for (const directory of directories) {
    try {
      paths.push(...(await readdir(join(root, directory))).sort().map((name) => `${directory}/${name}`));
    } catch {
      if (directory === 'docs/taste/vignettes') throw new Error('Canonical public Taste directory unavailable');
    }
  }
  return paths;
}

function applySearchRow(byAnchor: Map<string, TasteEntry>, row: PullRecallRow, threadId: string): void {
  const candidates = parseAnchors(row.candidates_json);
  const consumed = parseAnchors(row.consumed_json);
  for (const anchor of candidates) {
    const stats = byAnchor.get(anchor)?.search;
    if (stats) stats.hits += 1;
  }
  for (const anchor of consumed) {
    const stats = byAnchor.get(anchor)?.search;
    if (stats) stats.opened += 1;
  }
  for (const anchor of new Set([...candidates, ...consumed])) {
    const stats = byAnchor.get(anchor)?.search;
    if (stats) stats.latest = { threadId, recalledAt: row.timestamp, opened: consumed.has(anchor) };
  }
}

function recordUnverifiedRow(byAnchor: Map<string, TasteEntry>, row: PullRecallRow): boolean {
  const anchors = new Set([...parseAnchors(row.candidates_json), ...parseAnchors(row.consumed_json)]);
  let matched = false;
  for (const anchor of anchors) {
    const stats = byAnchor.get(anchor)?.search;
    if (!stats) continue;
    stats.unverified += 1;
    matched = true;
  }
  return matched;
}

/** Server-side read model: exact-vignette cues, shared dimension cues, and F200 pull evidence stay separate. */
export class TasteObservatoryReader {
  private readonly cueSummary: MemoryCueSourceSummaryReader;

  constructor(
    private readonly db: Database.Database,
    private readonly tasteRepository: TasteRepository,
    private readonly privateOwnerUserId: string,
    private readonly invocationRecordStore: Pick<IInvocationRecordStore, 'get'>,
    private readonly turnExecutionStore: Pick<ITurnExecutionStore, 'get'>,
    private readonly threadStore: Pick<IThreadStore, 'get'>,
  ) {
    this.cueSummary = new MemoryCueSourceSummaryReader(db);
  }

  async read(ownerUserId: string, options: { includePrivate?: boolean } = {}): Promise<TasteObservatorySnapshot> {
    const entries = await this.readApprovedEntries(ownerUserId, options.includePrivate !== false);
    const constellations = this.readConstellations(ownerUserId, entries);
    const totalUnverified = await this.applyVerifiedPullRecall(ownerUserId, entries);
    return {
      entries,
      constellations,
      coverage: { scope: 'verified_invocations_and_owner_threads', totalUnverified, sharedUnknownPolicy: 'excluded' },
    };
  }

  private async readApprovedEntries(ownerUserId: string, includePrivate: boolean): Promise<TasteEntry[]> {
    const root = await resolveCanonicalTasteRoot(this.tasteRepository);
    const reader = new TasteMemoryReader(
      { canonicalRoot: () => root, approvalLockKey: () => this.tasteRepository.approvalLockKey() },
      ownerUserId,
    );
    const entries: TasteEntry[] = [];
    for (const sourcePath of await listSourcePaths(root, includePrivate && ownerUserId === this.privateOwnerUserId)) {
      const result = await reader.read({ ownerUserId, sourcePath });
      if (!result) continue;
      const trigger = namedTrigger(sourcePath);
      const summary = trigger ? this.cueSummary.summarize(ownerUserId, 'taste', trigger.anchor) : null;
      entries.push({
        sourcePath,
        visibility: result.visibility,
        dimension: result.payload.dimension ?? null,
        namedDelivery:
          trigger && summary ? { trigger: trigger.trigger, counts: summary.counts, latest: summary.latest } : null,
        dimensionHint: result.payload.dimension
          ? { attribution: 'constellation_only' as const, dimension: result.payload.dimension }
          : null,
        search: result.visibility === 'public' ? ZERO_SEARCH() : null,
      });
    }
    return entries;
  }

  private readConstellations(ownerUserId: string, entries: readonly TasteEntry[]): Constellation[] {
    const groups = new Map<string, Constellation>();
    for (const entry of entries) {
      if (entry.dimension && !groups.has(entry.dimension)) {
        groups.set(entry.dimension, {
          dimension: entry.dimension,
          attribution: 'shared_hint',
          hints: ZERO_COUNTS(),
          latest: null,
        });
      }
    }
    const rows = this.db
      .prepare(`SELECT DISTINCT source_anchor FROM memory_cue_events
      WHERE owner_user_id = ? AND resolver_family = 'taste' AND source_anchor LIKE 'taste-dimensions:%'`)
      .all(ownerUserId) as Array<{ source_anchor: string }>;
    for (const row of rows) {
      const dimensions = new Set(row.source_anchor.slice('taste-dimensions:'.length).split(',').filter(Boolean));
      const summary = this.cueSummary.summarize(ownerUserId, 'taste', row.source_anchor);
      for (const dimension of dimensions) {
        const group = groups.get(dimension);
        if (!group) continue;
        addCounts(group.hints, summary.counts);
        if (summary.latest && (!group.latest || summary.latest.presentedAt > group.latest.presentedAt)) {
          group.latest = summary.latest;
        }
      }
    }
    return [...groups.values()].sort((a, b) => a.dimension.localeCompare(b.dimension));
  }

  private async applyVerifiedPullRecall(ownerUserId: string, entries: TasteEntry[]): Promise<number> {
    const byAnchor = new Map(
      entries.filter((entry) => entry.search).map((entry) => [searchAnchor(entry.sourcePath), entry]),
    );
    const rows = this.db
      .prepare(`SELECT recall_id, invocation_id, thread_id, candidates_json, consumed_json, timestamp
      FROM recall_events WHERE source = 'pull'
        AND (candidates_json LIKE '%doc:taste/vignettes/%' OR consumed_json LIKE '%doc:taste/vignettes/%')
      ORDER BY timestamp ASC, recall_id ASC`)
      .all() as PullRecallRow[];
    const ownership = new Map<string, InvocationOwnership>();
    const ownedThreads = new Map<string, boolean>();
    let totalUnverified = 0;
    for (const row of rows) {
      const disposition = await this.classifyRecallRow(ownerUserId, row, ownership, ownedThreads);
      if (disposition.kind === 'owned') applySearchRow(byAnchor, row, disposition.threadId);
      if (disposition.kind === 'unverified' && recordUnverifiedRow(byAnchor, row)) totalUnverified += 1;
    }
    return totalUnverified;
  }

  private async classifyRecallRow(
    ownerUserId: string,
    row: PullRecallRow,
    ownership: Map<string, InvocationOwnership>,
    ownedThreads: Map<string, boolean>,
  ): Promise<InvocationOwnership | { kind: 'excluded' }> {
    if (!ownership.has(row.invocation_id)) {
      ownership.set(row.invocation_id, await this.resolveInvocationOwner(ownerUserId, row.invocation_id));
    }
    const principal = ownership.get(row.invocation_id);
    if (principal?.kind === 'foreign') return { kind: 'excluded' };
    if (principal?.kind === 'owned' && (!row.thread_id || row.thread_id === principal.threadId)) return principal;
    if (!row.thread_id) return { kind: 'excluded' };
    if (!ownedThreads.has(row.thread_id)) {
      const thread = await this.threadStore.get(row.thread_id);
      ownedThreads.set(row.thread_id, thread?.createdBy === ownerUserId);
    }
    return ownedThreads.get(row.thread_id) ? { kind: 'unverified' } : { kind: 'excluded' };
  }

  private async resolveInvocationOwner(ownerUserId: string, invocationId: string): Promise<InvocationOwnership> {
    const invocation = await this.invocationRecordStore.get(invocationId);
    if (invocation)
      return invocation.userId === ownerUserId ? { kind: 'owned', threadId: invocation.threadId } : { kind: 'foreign' };
    const child = await this.turnExecutionStore.get(invocationId);
    if (!child) return { kind: 'unverified' };
    if (child.userId !== ownerUserId) return { kind: 'foreign' };
    const parent = await this.invocationRecordStore.get(child.parentInvocationId);
    return parent?.userId === ownerUserId && parent.threadId === child.threadId
      ? { kind: 'owned', threadId: child.threadId }
      : { kind: 'unverified' };
  }
}
