/**
 * F233 Phase C C2a — FeatTrajectoryProjector（三源 → feat 维度 trajectory 投影）
 *
 * 照 Phase B `BallCustodyProjector` 模式：
 * - 纯函数 / 零 git/gh IO（store.save 是 projection state 持久化不算外部副作用）
 * - apply(entry) = read projection → upsert / append → save
 * - rebuild = delete all + replay 三源全部 entries → 同结果（INV-2）
 *
 * **砚砚 P2-2 collector/projector 分层**：git/gh IO 在 collector，projector 只消费
 * DTO（`GitRefSnapshot` / `BallCustodyEvent` / stitched payload）。
 *
 * **三源 apply 路径**：
 * - `applyBallCustodyEvent(event, featId)`：event-stream source；trajectory kind 由
 *   ball-custody event kind + payload 映射（conservative：未明确映射 → skip per
 *   砚砚 step 3 advisory #1）；entry id = `evt:{event.sourceEventId}` (砚砚 step 3
 *   advisory #2: single-feat contract，同 event 只投一个 feat)。
 * - `applyGitRefSnapshot(snapshot)`：git-ref-snapshot source；step 3+ RED, step 4 impl.
 * - `applyStitchedEntry(entry)`：historical-stitched source；step 3+ RED.
 *
 * plan: docs/plans/2026-06-18-f233-phase-c-euthanasia-trajectory.md §C
 */

import type {
  BallCustodyEvent,
  BallShapedTrajectoryKind,
  FeatTrajectoryEntry,
  FeatTrajectoryProjection,
  FeatTrajectorySource,
  GitRefSnapshot,
  GitShapedTrajectoryKind,
  StaleBucket,
} from '@cat-cafe/shared';
import type { IFeatTrajectoryStore } from './FeatTrajectoryStore.js';
import {
  makeEventStreamEntryId,
  makeFeatSubjectKey,
  makeGitRefEntryId,
  makeGitRefSubjectKey,
  STALE_BUCKET_THRESHOLDS_MS,
  staleBucketForAge,
} from './feat-trajectory-keys.js';

/**
 * Map ball-custody event → trajectory kind（conservative per 砚砚 step 3 advisory #1）。
 *
 * Strategy: 未明确映射 → return null → projector skip (no entry created)。
 * 显式 rules 随 feat-aware semantics 浮现逐步加。
 *
 * Current explicit rule:
 * - `ball.handed_cvo` with `payload.intent === 'done_notify'` → 'closed'
 *   (operator 显式标 feat done，是 feat-level lifecycle event)
 *
 * All other Phase B + C ball-custody events skip for now（task.done / invocation.*
 * / ball.frozen 等都是球权层语义不直接投 feat trajectory；如果 task associated with
 * feat AC 或 PR merge event 出现，可加 rule 但需要 join 信息走 collector 不在
 * projector）。
 */
export function mapBallCustodyEventToTrajectory(event: BallCustodyEvent): BallShapedTrajectoryKind | null {
  if (event.kind === 'ball.handed_cvo') {
    const intent = (event.payload as { intent?: string }).intent;
    if (intent === 'done_notify') return 'closed';
  }
  return null;
}

/** Empty projection for a new featId. */
function createInitialFeatTrajectoryProjection(featId: string, now: number): FeatTrajectoryProjection {
  return {
    featId,
    entries: [],
    countsBySource: {
      'event-stream': 0,
      'historical-stitched': 0,
      'git-ref-snapshot': 0,
    } as Record<FeatTrajectorySource, number>,
    countsByKind: {},
    appliedEntryCount: 0,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Upsert helper: 同 entryId → replace; 新 entryId → append + sort + counts++。
 * 砚砚 P2-2 + advisory #2: 同 sourceEventId + 同 featId 幂等。
 */
function upsertEntry(proj: FeatTrajectoryProjection, entry: FeatTrajectoryEntry): void {
  const idx = proj.entries.findIndex((e) => e.entryId === entry.entryId);
  if (idx >= 0) {
    // Upsert: replace existing entry，不增 counts (idempotent)
    proj.entries[idx] = entry;
  } else {
    // New entry: append + sort by at + bump counts
    proj.entries.push(entry);
    proj.entries.sort((a, b) => a.at - b.at);
    proj.appliedEntryCount += 1;
    proj.countsBySource[entry.source] = (proj.countsBySource[entry.source] ?? 0) + 1;
    proj.countsByKind[entry.kind] = (proj.countsByKind[entry.kind] ?? 0) + 1;
  }
  // 砚砚 step 3 advisory (step 4 护栏)：monotonic max，防止 step 4+ git/stitch 多源
  // out-of-order apply 让 projection.updatedAt 时间倒退。
  proj.updatedAt = Math.max(proj.updatedAt, entry.at);
}

/**
 * Helper: build a FeatTrajectoryEntry for a git-ref-snapshot source kind.
 *
 * Cloud P2 fix: per-kind stable id derivation — id depends on event identity,
 * not surrounding volatile state（避免 PR state 变化重复 emit branch_pushed，
 * head 变化重复 emit pr_opened 等）。
 */
function makeSnapshotEntry(
  snapshot: GitRefSnapshot,
  featId: string,
  subjectKey: string,
  kind: GitShapedTrajectoryKind,
  at: number,
  staleBucket: StaleBucket | null,
): FeatTrajectoryEntry {
  let entryId: string;
  switch (kind) {
    case 'branch_pushed':
      entryId = makeGitRefEntryId({
        kind: 'branch_pushed',
        branchName: snapshot.branchName,
        headCommitSha: snapshot.headCommitSha,
      });
      break;
    case 'pr_opened': {
      if (snapshot.prNumber === null) {
        throw new Error('FeatTrajectoryProjector.makeSnapshotEntry: pr_opened requires snapshot.prNumber');
      }
      entryId = makeGitRefEntryId({
        kind: 'pr_opened',
        branchName: snapshot.branchName,
        prNumber: snapshot.prNumber,
      });
      break;
    }
    case 'branch_merged_to_main': {
      if (snapshot.prNumber === null) {
        throw new Error('FeatTrajectoryProjector.makeSnapshotEntry: branch_merged_to_main requires snapshot.prNumber');
      }
      entryId = makeGitRefEntryId({
        kind: 'branch_merged_to_main',
        branchName: snapshot.branchName,
        prNumber: snapshot.prNumber,
      });
      break;
    }
    case 'branch_stale_unmerged': {
      if (staleBucket === null) {
        throw new Error('FeatTrajectoryProjector.makeSnapshotEntry: branch_stale_unmerged requires staleBucket');
      }
      entryId = makeGitRefEntryId({
        kind: 'branch_stale_unmerged',
        branchName: snapshot.branchName,
        headCommitSha: snapshot.headCommitSha,
        staleBucket,
      });
      break;
    }
  }
  return {
    entryId,
    subjectKey,
    featId,
    at,
    kind,
    source: 'git-ref-snapshot',
    payload: {
      snapshot,
      joinProvenance: snapshot.joinProvenance,
      // 砚砚 step 4 护栏：detectedAt 记 collector observation 真实时间（与 entry.at 显式分开）
      detectedAt: snapshot.collectedAt,
      ...(staleBucket !== null ? { staleBucket } : {}),
    },
  };
}

export class FeatTrajectoryProjector {
  constructor(private readonly store: IFeatTrajectoryStore) {}

  /**
   * 事件流轨 source — ball-custody event → feat trajectory entry (event-stream)。
   *
   * 砚砚 step 3 advisory #1: conservative mapping (unmappable → skip, no entry).
   * 砚砚 step 3 advisory #2: `evt:{sourceEventId}` 假设 single-feat 投影；
   * 调用方负责保证同 sourceEventId 只投到一个 featId（collector 层 enforce）。
   */
  async applyBallCustodyEvent(event: BallCustodyEvent, featId: string): Promise<void> {
    const mappedKind = mapBallCustodyEventToTrajectory(event);
    if (mappedKind === null) {
      // Conservative skip: unmapped event kinds 不产生 trajectory entry。
      return;
    }

    const entry: FeatTrajectoryEntry = {
      entryId: makeEventStreamEntryId(event.sourceEventId),
      subjectKey: makeFeatSubjectKey(featId),
      featId,
      at: event.at,
      kind: mappedKind,
      source: 'event-stream',
      payload: { ballCustodyEvent: event },
    };

    const existing = await this.store.get(featId);
    const proj = existing ?? createInitialFeatTrajectoryProjection(featId, event.at);
    upsertEntry(proj, entry);
    await this.store.save(proj);
  }

  /**
   * git ref 轨 source — collector 派生的 snapshot → trajectory entries（upsert by
   * `gitRefEntryId`）。
   *
   * **每 snapshot 可能 emit 多条 entries**（按 git ref state 拆 kind）：
   * - `branch_pushed`: 总是 emit; `entry.at = snapshot.headCommitAt`（真实 git push 时间）
   * - `pr_opened`: 仅当 `prOpenedAt !== null` emit; `entry.at = prOpenedAt`（砚砚 step 4 护栏：null → skip emit，不 fallback collectedAt 伪装观测时间）
   * - `branch_merged_to_main`: 仅当 `prMergedAt !== null && mergedToMain === true` emit;
   *   `entry.at = prMergedAt`（同 null → skip）
   * - `branch_stale_unmerged`: 仅当 `mergedToMain !== true` AND `ageMs ≥ 24h` emit;
   *   `entry.at = headCommitAt + bucketThresholdMs`（首次跨阈值时刻；
   *   `payload.detectedAt = collectedAt` 记 observation 真实时间）
   *
   * **single-feat contract** (砚砚 step 3 advisory #2)：collector 选 single
   * high-confidence candidate（multiCandidatePolicy='skip-low-confidence'，default）。
   * Projector 信任 `featureCandidates[0]` 是 collector 决定的目标 featId。
   * 0 candidates → skip whole snapshot（无 feat 关联，无轨迹意义）。
   */
  async applyGitRefSnapshot(snapshot: GitRefSnapshot): Promise<void> {
    if (snapshot.featureCandidates.length === 0) return; // no join, skip whole snapshot

    const featId = snapshot.featureCandidates[0]; // collector enforces single-candidate via policy
    const subjectKey = makeGitRefSubjectKey(snapshot.branchName);

    const existing = await this.store.get(featId);
    const proj = existing ?? createInitialFeatTrajectoryProjection(featId, snapshot.headCommitAt);

    // ── branch_pushed (always; entry.at = headCommitAt) ───────────────────
    upsertEntry(proj, makeSnapshotEntry(snapshot, featId, subjectKey, 'branch_pushed', snapshot.headCommitAt, null));

    // ── pr_opened (null → skip emit, 砚砚 step 4 护栏) ────────────────────
    if (snapshot.prOpenedAt !== null) {
      upsertEntry(proj, makeSnapshotEntry(snapshot, featId, subjectKey, 'pr_opened', snapshot.prOpenedAt, null));
    }

    // ── branch_merged_to_main (null prMergedAt 或非 mergedToMain → skip) ──
    if (snapshot.prMergedAt !== null && snapshot.mergedToMain === true) {
      upsertEntry(
        proj,
        makeSnapshotEntry(snapshot, featId, subjectKey, 'branch_merged_to_main', snapshot.prMergedAt, null),
      );
    }

    // ── branch_stale_unmerged (仅 unmerged + ageMs ≥ 24h，bucket-derived entry.at) ──
    if (snapshot.mergedToMain !== true) {
      const ageMs = snapshot.collectedAt - snapshot.headCommitAt;
      const bucket = staleBucketForAge(ageMs);
      if (bucket !== null) {
        const bucketEntryAt = snapshot.headCommitAt + STALE_BUCKET_THRESHOLDS_MS[bucket];
        upsertEntry(
          proj,
          makeSnapshotEntry(snapshot, featId, subjectKey, 'branch_stale_unmerged', bucketEntryAt, bucket),
        );
      }
    }

    await this.store.save(proj);
  }

  /**
   * 历史回填轨 source — stitched 一次性脚本产物，直接喂 entry（projector 不重算）。
   *
   * @throws Step 5+ RED, not implemented yet.
   */
  async applyStitchedEntry(_entry: FeatTrajectoryEntry): Promise<void> {
    throw new Error('FeatTrajectoryProjector.applyStitchedEntry: step 5+ RED, not implemented yet');
  }
}
