/**
 * F233 Phase C C2b step 2 part 2 — `RealGhClient` 真实 gh CLI adapter
 *
 * 替换 C2a 的 mock `GhClient` interface 用 child_process spawn 真实 `gh pr list`
 * 拉真实 PR metadata 含 `createdAt` / `mergedAt` 真实 timestamp（砚砚 step 3.6
 * 护栏：不能用 observation time 伪装真实事件时间）。
 *
 * 为啥用 gh CLI 不直接调 REST API：
 * - gh CLI 已经处理好 auth（用户已 `gh auth login`），不用我们管 token 存哪 / 刷新
 * - 跟 dev 习惯一致，少一个 auth 风险面
 * - 失败的 stderr 直接说人话，方便排错
 *
 * 测试性：`ghCmd` 注入式（生产 = spawn；tests = stub returning canned JSON）。
 *
 * mergedToMain 判定：仅当 `state === 'merged' AND baseRefName ∈ {main, master}`
 * 才为 true。feature → feature 的 PR merge 不算 "merged to main"（不会进
 * `branch_merged_to_main` 轨迹）。
 *
 * plan: docs/plans/2026-06-18-f233-phase-c-euthanasia-trajectory.md §C2b
 */

import { spawn } from 'node:child_process';
import type { GhClient, PrInfo } from './GitRefSnapshotCollector.js';

/** 注入式 gh 命令执行器 — 返回 stdout 字符串，非零退出抛错。 */
export type GhCmdRunner = (args: readonly string[]) => Promise<string>;

/** Logger for graceful-degrade warnings (consistent with collector / scheduler shape). */
export interface GhClientLogger {
  warn?: (obj: unknown, msg?: string) => void;
}

export class RealGhClient implements GhClient {
  constructor(
    /** Repo full name, e.g. 'zts212653/cat-cafe'（gh --repo 用） */
    private readonly repoFullName: string,
    private readonly ghCmd: GhCmdRunner = defaultGhCmd,
    /** Which base branch names count as "main"（默认 main/master）。 */
    private readonly mainBranchNames: ReadonlySet<string> = new Set(['main', 'master']),
    /** Optional logger for graceful-degrade warnings (cloud round 2 P1 fix). */
    private readonly logger?: GhClientLogger,
  ) {}

  /**
   * `gh pr list --head <branchName> --state all` → 最近一条 PR（含 closed/merged）。
   * 返回 null 如果 branch 从未开过 PR（空数组）。
   *
   * 关键字段映射：
   * - `createdAt` → `prOpenedAt`（ISO 8601 → Unix ms）
   * - `mergedAt` → `prMergedAt`（ISO 8601 → Unix ms；非 merged PR 为 null）
   * - `mergedToMain` = (state === 'merged' AND baseRefName ∈ {main, master})
   *
   * Cloud round 2 P1 fix: gh subprocess errors (missing binary, unauthenticated,
   * network down, repo not found, rate limited) graceful-degrade to null
   * instead of throwing. PR metadata is OPTIONAL for git-only trajectory events
   * (branch_pushed / branch_stale_unmerged); a failed gh call should NOT take
   * down the entire branch snapshot. Validation errors (invalid JSON, missing
   * required fields, wrong types) still throw — those indicate gh contract
   * violations the caller must know about.
   */
  async findPrByBranch(branchName: string): Promise<PrInfo | null> {
    if (!branchName) return null;
    let stdout: string;
    try {
      stdout = await this.ghCmd([
        'pr',
        'list',
        '--repo',
        this.repoFullName,
        '--head',
        branchName,
        '--state',
        'all',
        '--json',
        'number,state,createdAt,mergedAt,headRefName,baseRefName',
        '--limit',
        '1',
      ]);
    } catch (e) {
      // gh subprocess failure: missing binary, gh auth login expired, network
      // down, repo not found, rate limit. Treat as "no PR metadata available"
      // → graceful degrade so git-only snapshots still emit (the branch + sha +
      // commit messages don't need a PR to be useful).
      this.logger?.warn?.(
        { err: e instanceof Error ? e.message : String(e), branchName, repoFullName: this.repoFullName },
        '[RealGhClient] gh PR lookup failed; treating as no PR (git-only snapshot will still emit)',
      );
      return null;
    }

    const trimmed = stdout.trim();
    if (!trimmed) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (e) {
      throw new Error(`RealGhClient: gh returned non-JSON stdout for branch ${branchName}: ${trimmed.slice(0, 200)}`);
    }
    if (!Array.isArray(parsed) || parsed.length === 0) return null;

    const pr = parsed[0] as {
      number?: number;
      state?: string;
      createdAt?: string;
      mergedAt?: string | null;
      headRefName?: string;
      baseRefName?: string;
    };
    if (typeof pr.number !== 'number') {
      throw new Error(`RealGhClient: gh PR missing 'number' field for branch ${branchName}`);
    }

    const stateLower = (pr.state ?? '').toLowerCase();
    if (stateLower !== 'open' && stateLower !== 'closed' && stateLower !== 'merged') {
      throw new Error(`RealGhClient: unexpected PR state from gh: '${pr.state}' (branch ${branchName})`);
    }

    if (!pr.createdAt) {
      throw new Error(`RealGhClient: gh PR missing 'createdAt' for branch ${branchName}`);
    }
    const prOpenedAt = Date.parse(pr.createdAt);
    if (!Number.isFinite(prOpenedAt)) {
      throw new Error(`RealGhClient: invalid createdAt from gh: '${pr.createdAt}' (branch ${branchName})`);
    }

    let prMergedAt: number | null = null;
    if (pr.mergedAt) {
      prMergedAt = Date.parse(pr.mergedAt);
      if (!Number.isFinite(prMergedAt)) {
        throw new Error(`RealGhClient: invalid mergedAt from gh: '${pr.mergedAt}' (branch ${branchName})`);
      }
    }

    const baseRefName = pr.baseRefName ?? '';
    const mergedToMain = stateLower === 'merged' && this.mainBranchNames.has(baseRefName);

    return {
      prNumber: pr.number,
      prState: stateLower as 'open' | 'closed' | 'merged',
      prOpenedAt,
      prMergedAt,
      mergedToMain,
    };
  }
}

/** Default real spawn-based gh command runner (production). */
const defaultGhCmd: GhCmdRunner = (args) =>
  new Promise((resolve, reject) => {
    const proc = spawn('gh', args as readonly string[], {
      env: { ...process.env, GH_PROMPT_DISABLED: '1' },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    proc.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`gh ${args.join(' ')} exited ${code}: ${stderr.trim()}`));
    });
  });
