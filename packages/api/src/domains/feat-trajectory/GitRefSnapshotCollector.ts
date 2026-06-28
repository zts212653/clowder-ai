/**
 * F233 Phase C C2a — GitRefSnapshotCollector（git/gh IO + heuristic join）
 *
 * 砚砚 P2-2 collector/projector 分层：所有 git/gh IO 住在 collector，
 * 输出 immutable `GitRefSnapshot` DTO 喂 `FeatTrajectoryProjector`（projector
 * 纯函数 / rebuild-safe / 零外部副作用）。
 *
 * **Collector 职责（OQ-8 锁定 + 砚砚 P2-1 join 字段）**：
 * 1. `git ls-remote` 扫所有 remote refs（fix/* / feat/* 优先，可配置 pattern）
 * 2. 对每条 ref：HEAD commit sha + commit timestamp + author identity + commit messages
 * 3. GitHub PR API map → 是否有 PR / PR state / mergedToMain / **prOpenedAt / prMergedAt 真实时间**
 * 4. Heuristic join（feat_index / commit_message_F# / branch_name_F#）→
 *    featureCandidates + associatedThreadIds + 最后 thread message / activity
 *    时间 + joinProvenance（cloud round 3 P2 fix: thread_keyword discovery
 *    暂未实现，已从 supported join methods 移除）
 * 5. tick 时间 `collectedAt`（projector 用此 + headCommitAt 算 ageMs → staleBucket）
 *
 * **砚砚 advisory #2 (step 2/3 review) + step 4 part 1 review**：
 * - `multiCandidatePolicy` default `'skip-low-confidence'`（production-safe）
 * - 0 candidates → skip emit (无 feat join, projector 无法选 single-feat)
 * - low confidence → skip emit (避免污染轨迹 with weak join)
 * - multi-candidate (>1 even with high confidence) → skip emit (single-feat 模糊)
 * - F188 fixture 路径：single high-confidence (branch_name_F# + commit_message_F# 双证据)
 *
 * **真实 PR timestamp contract（砚砚 step 3.6 + step 4 part 1 护栏）**：
 * `prOpenedAt` 必须从 GitHub PR API `created_at` 真实拿；`prMergedAt` 从 `merged_at`
 * 真实拿。API 失败 / PR 不存在 → null → projector skip emit `pr_opened` / `branch_merged_to_main`
 * （避免 collectedAt 伪装真实事件时间污染轨迹）。
 *
 * **Cron schedule**：照 Phase B ProbeScheduler pattern（server-side cron tick，
 * 不走 client-side post-push hook，KD-2 单账本 + KD-4 给数据不给结论）。tick
 * interval 由 F233_FEAT_TRAJECTORY_COLLECTOR_INTERVAL_MS 控制（step 5 引入）。
 *
 * plan: docs/plans/2026-06-18-f233-phase-c-euthanasia-trajectory.md §C
 */

import type { FeatThreadJoinMethod, GitRefSnapshot } from '@cat-cafe/shared';

// ============================================================================
// Injection interfaces（test-friendly mock IO boundary）
// ============================================================================

export interface GitBranchRef {
  branchName: string;
  headCommitSha: string;
}

export interface GitCommitMeta {
  headCommitAt: number; // Unix ms
  authorIdentity: string; // commit author email/login derived
  commitMessages: string[]; // recent commits on branch（for commit_message_F# join）
}

export interface PrInfo {
  prNumber: number;
  prState: 'open' | 'closed' | 'merged';
  /** GitHub API `created_at` (Unix ms) — 砚砚 step 3.6 真实事件时间 contract */
  prOpenedAt: number;
  /** GitHub API `merged_at` (Unix ms)；非 merged PR 为 null */
  prMergedAt: number | null;
  /** Whether PR was actually merged to main (vs closed/discarded) */
  mergedToMain: boolean;
}

export interface ThreadMatch {
  threadId: string;
  /** Unix ms; null if thread has no message */
  lastMessageAt: number | null;
  /** Unix ms; null if no activity record */
  lastActivityAt: number | null;
}

/**
 * Mock-friendly IO interfaces — production impls 在 step 5 落地（git CLI runner /
 * gh REST client / Redis feat_index / thread store）。
 */
export interface GitRunner {
  /**
   * Optional: pre-fetch + prune remote refs before lsRemote/getCommitMeta. Production
   * impls run `git fetch origin --prune` so newly pushed remote branches have their
   * objects available for getCommitMeta. Tests omit; safe to skip (existing behavior).
   * 砚砚 final review P1: without prefetch, ls-remote 拿到的远端 SHA 在 local 还没
   * fetch → getCommitMeta 失败 → 整 collectAll 归零, 提包球 (git-only stale branch)
   * 暴露路径无法工作.
   */
  prefetch?(): Promise<void>;
  /** Scan refs matching pattern (default fix/* + feat/*). */
  lsRemote(branchPatterns: string[]): Promise<GitBranchRef[]>;
  /** Get commit metadata for a SHA. */
  getCommitMeta(sha: string, branchName: string): Promise<GitCommitMeta>;
}

export interface GhClient {
  /** Find PR by branch head. Returns null if no PR ever opened. */
  findPrByBranch(branchName: string): Promise<PrInfo | null>;
}

export interface FeatIndexLookup {
  /**
   * Find feat ids associated with this branch (feat_index registration table).
   * Returns empty array if no match.
   */
  findByBranch(branchName: string): Promise<string[]>;
}

export interface ThreadSearch {
  /** Threads associated with a featId (e.g., thread 标签含 F#). */
  findByFeatId(featId: string): Promise<ThreadMatch[]>;
}

// ============================================================================
// Multi-candidate policy + heuristic join
// ============================================================================

export type MultiCandidatePolicy = 'skip-low-confidence' | 'emit-per-candidate-low-confidence';

export interface MultiCandidateDecision {
  decision: 'emit' | 'skip';
  reason?: string;
  selectedFeatId?: string;
}

/**
 * Apply multiCandidatePolicy to candidates list.
 *
 * default `skip-low-confidence` (砚砚 step 2 advisory #2 + step 4 part 1 review)：
 * - 0 candidates → skip (无 feat join)
 * - low confidence → skip (避免污染轨迹)
 * - multi-candidate（即使 high conf） → skip (single-feat 模糊，无法决定投哪个)
 * - single high/medium confidence → emit
 */
export function applyMultiCandidatePolicy(
  candidates: string[],
  confidence: 'high' | 'medium' | 'low',
  policy: MultiCandidatePolicy,
): MultiCandidateDecision {
  if (candidates.length === 0) {
    return { decision: 'skip', reason: 'no candidates (heuristic join 无命中)' };
  }
  if (policy === 'skip-low-confidence') {
    if (confidence === 'low') {
      return { decision: 'skip', reason: 'low confidence (避免污染轨迹 with weak join)' };
    }
    if (candidates.length > 1) {
      return {
        decision: 'skip',
        reason: `multi-candidate ambiguity (${candidates.length} 个候选，single-feat 无法决定)`,
      };
    }
    return { decision: 'emit', selectedFeatId: candidates[0] };
  }
  // 'emit-per-candidate-low-confidence' — 砚砚 step 4 part 2 review P3：
  // 实现只返回 first candidate 与命名/语义不一致。explicit throw 防止配置到
  // 这个 policy 时静默错误投到第一个候选。Future 真正落地时改成 emit per
  // candidate（每个 candidate 各一条 entry + confidence 标 low/medium）。
  throw new Error(
    "MultiCandidatePolicy 'emit-per-candidate-low-confidence' not yet implemented; use 'skip-low-confidence' (default)",
  );
}

/** Heuristic join 4 methods 输出。 */
export interface HeuristicJoinResult {
  featureCandidates: string[];
  joinedVia: FeatThreadJoinMethod[];
  confidence: 'high' | 'medium' | 'low';
}

/**
 * 启发式 join：4 方法累加证据 → confidence 由证据强度决定。
 *
 * - `feat_index` (highest)：feat_index 表显式注册（operator/猫主动登记）
 * - `branch_name_F#`：branch 命名含 F# pattern, e.g. `fix/f188-*` / `feat/f233-*`
 * - `commit_message_F#`：commit message 含 `F188:` / `F233:` 等 conventional commit pattern
 *
 * Note (cloud round 3 P2 fix, PR #2439): `thread_keyword` as a discovery method
 * has been removed from `FeatThreadJoinMethod` type entirely. Discovering featId
 * from thread content needs a new IO method (e.g. `ThreadSearch.findByBranchKeyword`),
 * which is outside C2a scope. The thread search done in `collectThreadJoin` is
 * post-discovery confirmation only (find threads associated with the already-selected
 * featId for last-activity timestamps — F188 invariant support).
 *
 * Confidence rules:
 * - has `feat_index` → high
 * - has `branch_name_F#` AND `commit_message_F#` (双证据) → high
 * - has `branch_name_F#` OR `commit_message_F#` (单证据) → medium
 * - 仅 heuristic 无显式 anchor → low
 */
export function heuristicFeatJoin(branchName: string, commitMessages: string[]): HeuristicJoinResult {
  const candidates = new Set<string>();
  const joinedVia: FeatThreadJoinMethod[] = [];

  // Method 2: branch_name_F# (case-insensitive)
  // Cloud P2 fix (GitRefSnapshotCollector.ts:182): use matchAll to collect ALL
  // F# from branch name. branchName.match() only captures first match, so
  // `fix/f188-f233-cleanup` would emit single F188 candidate (medium confidence)
  // instead of multi-candidate (skip per policy). Multi-feat branch names must
  // produce multi-candidate result so multiCandidatePolicy='skip-low-confidence'
  // correctly rejects ambiguous join.
  const branchMatches = branchName.matchAll(/[/\-_]([Ff])(\d{2,4})/g);
  let hasBranchMatch = false;
  for (const m of branchMatches) {
    candidates.add(`F${m[2]}`);
    hasBranchMatch = true;
  }
  if (hasBranchMatch) {
    joinedVia.push('branch_name_F#');
  }

  // Method 3: commit_message_F# (in any commit message, e.g. "F188: fix X" or "(F233 Phase C)")
  for (const msg of commitMessages) {
    const msgMatches = msg.matchAll(/\bF(\d{2,4})\b/g);
    for (const m of msgMatches) {
      candidates.add(`F${m[1]}`);
      if (!joinedVia.includes('commit_message_F#')) {
        joinedVia.push('commit_message_F#');
      }
    }
  }

  // Confidence calculation
  // Note: feat_index 在外层 async 函数加（因为需要 IO），这里只算 from-text 证据
  const hasBranch = joinedVia.includes('branch_name_F#');
  const hasCommit = joinedVia.includes('commit_message_F#');
  let confidence: 'high' | 'medium' | 'low';
  if (hasBranch && hasCommit) confidence = 'high';
  else if (hasBranch || hasCommit) confidence = 'medium';
  else confidence = 'low';

  return {
    featureCandidates: Array.from(candidates),
    joinedVia,
    confidence,
  };
}

// ============================================================================
// Collector impl
// ============================================================================

export interface IGitRefSnapshotCollector {
  collectAll(now: number): Promise<GitRefSnapshot[]>;
  collectOne(branchName: string, now: number): Promise<GitRefSnapshot | null>;
}

export interface GitRefSnapshotCollectorOpts {
  branchPatterns?: string[];
  multiCandidatePolicy?: MultiCandidatePolicy;
  gitRunner: GitRunner;
  ghClient: GhClient;
  featIndexLookup: FeatIndexLookup;
  threadSearch: ThreadSearch;
  /** Optional logger for per-branch failure isolation diagnostics (砚砚 final review P1). */
  logger?: {
    warn?: (obj: unknown, msg?: string) => void;
    info?: (obj: unknown, msg?: string) => void;
    error?: (obj: unknown, msg?: string) => void;
  };
}

export class GitRefSnapshotCollector implements IGitRefSnapshotCollector {
  private readonly branchPatterns: string[];
  private readonly multiCandidatePolicy: MultiCandidatePolicy;

  constructor(private readonly opts: GitRefSnapshotCollectorOpts) {
    this.branchPatterns = opts.branchPatterns ?? ['fix/*', 'feat/*'];
    this.multiCandidatePolicy = opts.multiCandidatePolicy ?? 'skip-low-confidence';
  }

  /**
   * Census tick — scan all matching branches once, emit snapshot per branch with valid join.
   * 砚砚 step 4 part 2 review P2: single lsRemote scan, reused for all branches
   * (不退化成 N+1 remote scan，也不读到中间不一致 ref state)。
   */
  async collectAll(now: number): Promise<GitRefSnapshot[]> {
    // 砚砚 final review P1 fix part 1: prefetch remote refs so getCommitMeta has
    // local objects available. Without this, newly pushed remote branches fail
    // metadata lookup → entire tick zeroes out → 提包球 path broken.
    if (this.opts.gitRunner.prefetch) {
      try {
        await this.opts.gitRunner.prefetch();
      } catch (e) {
        this.opts.logger?.warn?.(
          { err: e instanceof Error ? e.message : String(e) },
          '[feat-trajectory-collector] prefetch failed; continuing with stale local refs',
        );
      }
    }

    const branches = await this.opts.gitRunner.lsRemote(this.branchPatterns);
    const snapshots: GitRefSnapshot[] = [];
    // 砚砚 final review P1 fix part 2: per-branch failure isolation — one bad
    // ref does not brick the whole tick (proper degradation path).
    for (const branchRef of branches) {
      try {
        const snap = await this.collectBranchRef(branchRef, now);
        if (snap !== null) snapshots.push(snap);
      } catch (e) {
        this.opts.logger?.warn?.(
          { branchName: branchRef.branchName, err: e instanceof Error ? e.message : String(e) },
          '[feat-trajectory-collector] branch metadata failed; skip this branch (per-branch isolation)',
        );
      }
    }
    return snapshots;
  }

  /**
   * Single-branch focused collect — test fixture + (future) targeted recheck entry。
   * 内部仍 lsRemote (单 branch 无法绕开 ref resolution)，但 production cron census
   * 走 collectAll() 不走 collectOne()，所以 N+1 scan 路径不会被 production 触发。
   */
  async collectOne(branchName: string, now: number): Promise<GitRefSnapshot | null> {
    const branches = await this.opts.gitRunner.lsRemote(this.branchPatterns);
    const branchRef = branches.find((b) => b.branchName === branchName);
    if (!branchRef) return null; // branch doesn't match patterns or doesn't exist
    return this.collectBranchRef(branchRef, now);
  }

  /**
   * Core per-branch collection logic — shared by collectAll() (single scan) and
   * collectOne() (single-branch entry)。砚砚 step 4 part 2 review P2 修复：
   * 提取共享 logic 避免 collectAll 退化成 N+1 lsRemote。
   *
   * Returns null if multiCandidatePolicy rejects this snapshot (skip emit).
   */
  private async collectBranchRef(branchRef: GitBranchRef, now: number): Promise<GitRefSnapshot | null> {
    // Step A: git layer minimum facts
    const meta = await this.opts.gitRunner.getCommitMeta(branchRef.headCommitSha, branchRef.branchName);
    const branchName = branchRef.branchName;

    // Step B: PR info from GitHub (real timestamps required per 砚砚 step 3.6 contract)
    const prInfo = await this.opts.ghClient.findPrByBranch(branchName);

    // Step C+D+E: Resolve feat join + apply policy decision (extracted to reduce complexity)
    const joinResult = await this.resolveJoinDecision(branchName, meta.commitMessages);
    if (joinResult.decision === 'skip') return null;

    // Step F: thread association (post-discovery) — find threads by featId for
    // last-activity timestamps used by the F188 invariant. NOT a discovery
    // source — `thread_keyword` was removed from `FeatThreadJoinMethod` type
    // entirely in cloud round 3 P2 fix (PR #2439) because the implementation
    // requires an already-known featId, so it cannot discover featId for
    // branches linked only by thread text.
    //
    // TODO (step 5+ or follow-up F#): implement thread-keyword discovery via
    // a new `ThreadSearch.findByBranchKeyword(branchName)` method that returns
    // feat candidates from thread content. Then re-add `thread_keyword` to the
    // FeatThreadJoinMethod type and call it BEFORE the policy decision (so
    // 0-F# branches with thread mentions are not silently dropped).
    const threadResult = await this.collectThreadJoin(joinResult.selectedFeatId);
    const joinedVia = [...joinResult.joinedVia];

    // Step G: build snapshot DTO
    return {
      branchName: branchRef.branchName,
      headCommitSha: branchRef.headCommitSha,
      headCommitAt: meta.headCommitAt,
      prNumber: prInfo?.prNumber ?? null,
      prState: prInfo?.prState ?? null,
      mergedToMain: prInfo?.mergedToMain ?? null,
      prOpenedAt: prInfo?.prOpenedAt ?? null,
      prMergedAt: prInfo?.prMergedAt ?? null,
      authorIdentity: meta.authorIdentity,
      featureCandidates: [joinResult.selectedFeatId], // single-feat contract enforced by policy
      associatedThreadIds: threadResult.associatedThreadIds,
      lastThreadMessageAt: threadResult.lastMessageAt,
      lastThreadActivityAt: threadResult.lastActivityAt,
      joinProvenance: { confidence: joinResult.confidence, joinedVia },
      collectedAt: now,
    };
  }

  /**
   * Resolve feat join decision: heuristic text join + feat_index promote + policy.
   * Extracted from collectBranchRef to reduce cognitive complexity.
   */
  private async resolveJoinDecision(
    branchName: string,
    commitMessages: string[],
  ): Promise<
    | { decision: 'skip' }
    | {
        decision: 'emit';
        selectedFeatId: string;
        confidence: 'high' | 'medium' | 'low';
        joinedVia: FeatThreadJoinMethod[];
      }
  > {
    const textJoin = heuristicFeatJoin(branchName, commitMessages);
    const fromIndex = await this.opts.featIndexLookup.findByBranch(branchName);

    let confidence = textJoin.confidence;
    const joinedVia = [...textJoin.joinedVia];
    const candidates = new Set(textJoin.featureCandidates);
    if (fromIndex.length > 0) {
      for (const f of fromIndex) candidates.add(f);
      joinedVia.unshift('feat_index'); // 优先 position
      confidence = 'high'; // feat_index = ground truth anchor
    }

    const decision = applyMultiCandidatePolicy(Array.from(candidates), confidence, this.multiCandidatePolicy);
    if (decision.decision === 'skip') return { decision: 'skip' };
    return {
      decision: 'emit',
      selectedFeatId: decision.selectedFeatId as string,
      confidence,
      joinedVia,
    };
  }

  /**
   * Collect thread join: find threads for featId + accumulate last activity timestamps.
   * Extracted from collectBranchRef to reduce cognitive complexity.
   */
  private async collectThreadJoin(featId: string): Promise<{
    associatedThreadIds: string[];
    lastMessageAt: number | null;
    lastActivityAt: number | null;
  }> {
    const threads = await this.opts.threadSearch.findByFeatId(featId);
    let lastMessageAt: number | null = null;
    let lastActivityAt: number | null = null;
    for (const t of threads) {
      if (t.lastMessageAt !== null) {
        lastMessageAt = lastMessageAt === null ? t.lastMessageAt : Math.max(lastMessageAt, t.lastMessageAt);
      }
      if (t.lastActivityAt !== null) {
        lastActivityAt = lastActivityAt === null ? t.lastActivityAt : Math.max(lastActivityAt, t.lastActivityAt);
      }
    }
    return {
      associatedThreadIds: threads.map((t) => t.threadId),
      lastMessageAt,
      lastActivityAt,
    };
  }
}
