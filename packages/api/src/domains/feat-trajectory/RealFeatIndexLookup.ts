/**
 * F233 Phase C C2b step 2 part 3 — `RealFeatIndexLookup` 真实 feat_index adapter
 *
 * 替换 C2a 的 mock `FeatIndexLookup` interface 用 `docs/features/F###-*.md`
 * feat 文档扫描 + 缓存 branch → featIds[] 映射。
 *
 * 数据源：feat doc 是 single source of truth（不是 Redis 表）。每个 F### feat
 * 文档的文件名 (F188-*) + Timeline section 里出现的 branch 名（fix/F188-* /
 * feat/F233-* 等）→ 反向索引 branch → [featId]。
 *
 * 设计：
 * - 构造时不读盘；首次 `findByBranch` 时 lazy 扫一遍 + 缓存。
 * - `invalidateCache()` 让 cron / hot-reload 调用刷新（C2b cron 每 N 跳调一次）。
 * - `fsAdapter` 注入式（生产 = 真 node:fs；tests = stub returning canned content）
 *   → 测试不需要 fake 文件系统。
 *
 * 与 heuristic join 的关系：
 * - branch_name_F# / commit_message_F# heuristic 已经处理 95% case
 *   （branch 名带 F188 / commit message 提 F188）。
 * - feat_index 是高置信 anchor，用于：① 显式注册不规则命名的 branch；
 *   ② 升 heuristic 置信度从 medium → high（C2a 已实现该路径）。
 *
 * plan: docs/plans/2026-06-18-f233-phase-c-euthanasia-trajectory.md §C2b
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FeatIndexLookup } from './GitRefSnapshotCollector.js';

/** 注入式文件系统 adapter（生产用 node:fs，tests stub）。 */
export interface FeatIndexFsAdapter {
  listFeatDocs(featuresDir: string): Promise<string[]>;
  readFile(filePath: string): Promise<string>;
}

export class RealFeatIndexLookup implements FeatIndexLookup {
  private cache: Map<string, string[]> | null = null;
  private buildPromise: Promise<Map<string, string[]>> | null = null;

  constructor(
    /** Absolute path to `docs/features/` directory in cat-cafe repo. */
    private readonly featuresDir: string,
    private readonly fsAdapter: FeatIndexFsAdapter = defaultFsAdapter,
  ) {}

  async findByBranch(branchName: string): Promise<string[]> {
    if (!branchName) return [];
    const cache = await this.getCache();
    return cache.get(branchName) ?? [];
  }

  /** 让 cron / hot-reload 调用，下次 findByBranch 会重新扫盘。 */
  invalidateCache(): void {
    this.cache = null;
    this.buildPromise = null;
  }

  private async getCache(): Promise<Map<string, string[]>> {
    if (this.cache !== null) return this.cache;
    // Coalesce concurrent calls to a single scan
    if (this.buildPromise === null) {
      this.buildPromise = this.buildCache();
    }
    this.cache = await this.buildPromise;
    return this.cache;
  }

  private async buildCache(): Promise<Map<string, string[]>> {
    const cache = new Map<string, string[]>();
    let files: string[];
    try {
      files = await this.fsAdapter.listFeatDocs(this.featuresDir);
    } catch (_e) {
      // 目录不存在 / 无权限 — 优雅降级：返回空 cache（heuristic join 仍然能跑）
      return cache;
    }

    for (const filename of files) {
      // 只处理 `F###-name.md` 文件名 pattern
      const match = filename.match(/^F(\d{2,4})-.*\.md$/);
      if (!match) continue;
      const featId = `F${match[1]}`;

      let content: string;
      try {
        content = await this.fsAdapter.readFile(join(this.featuresDir, filename));
      } catch (_e) {
        continue; // 单个文件失败不要整个 cache 烧掉
      }

      // 从 feat doc 内容里抽 branch 名引用。两种模式组合：
      //
      // (a) 老规则保留：prose 里的 F### branches（高置信，e.g. `fix/F188-x`
      //     mentioned in plain text）。原始 motivation：避免在 prose 误匹配 `feat/care`
      //     这类非 branch token. F### token presence 是 precision guard.
      //
      // (b) Cloud round 3 P2 fix：backtick-quoted branches（不要求 F### in path）。
      //     feat doc 约定用 inline code 引 branch 名（`fix/redis-cleanup`）。
      //     backtick delimiter 提供 precision，可以放心 register F-less branch.
      //     这正是 feat_index 的设计目的——catch heuristic join (branch_name_F#)
      //     miss 的 branch，i.e. doc references like `fix/redis-cleanup` where
      //     branch name itself doesn't contain F###.
      //
      // Capture groups:
      //   m[1] = backtick-quoted any branch (cloud round 3 P2 fix)
      //   m[2] = prose F### branch (existing behavior, precision guard)
      const branchPattern =
        /`((?:fix|feat|hotfix|chore|docs|refactor|test|style)\/[A-Za-z0-9][\w./-]*[A-Za-z0-9_])`|\b((?:fix|feat|hotfix|chore|docs|refactor|test|style)\/[Ff]\d{2,4}[-\w/]*)/g;
      const matches = content.matchAll(branchPattern);
      for (const m of matches) {
        const branchName = m[1] ?? m[2];
        if (!branchName) continue;
        const existing = cache.get(branchName);
        if (existing) {
          if (!existing.includes(featId)) existing.push(featId);
        } else {
          cache.set(branchName, [featId]);
        }
      }
    }
    return cache;
  }
}

/** Default real node:fs adapter (production). */
const defaultFsAdapter: FeatIndexFsAdapter = {
  async listFeatDocs(featuresDir: string): Promise<string[]> {
    const entries = await readdir(featuresDir);
    return entries.filter((name) => /^F\d{2,4}-.*\.md$/.test(name));
  },
  async readFile(filePath: string): Promise<string> {
    return readFile(filePath, 'utf8');
  },
};
