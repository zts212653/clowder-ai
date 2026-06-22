/**
 * F233 Phase C C2b step 2 — `RealGitRunner` 真实 git CLI adapter
 *
 * 替换 C2a 的 mock `GitRunner` interface 用 child_process spawn 真实 `git` 命令
 * 跑 `ls-remote` + `show` + `log` 拉真实 branch + commit metadata。
 *
 * 设计：
 * - `gitCmd` 命令执行器作为构造参数注入（生产 = 真 spawn；tests = stub returning
 *   预制 stdout）。这样 unit test 不需要 fake git repo / fork process。
 * - `repoRoot` 是 cat-cafe 仓根目录（含 `.git`）。生产从 env 或 config 传入；
 *   tests 传 fake path（gitCmd stub 不在乎 cwd）。
 *
 * 安全：spawn 不走 shell，args 数组传入，避免 shell injection。
 *
 * plan: docs/plans/2026-06-18-f233-phase-c-euthanasia-trajectory.md §C2b
 */

import { spawn } from 'node:child_process';
import type { GitBranchRef, GitCommitMeta, GitRunner } from './GitRefSnapshotCollector.js';

/** 注入式 git 命令执行器 — 返回 stdout 字符串，非零退出抛错。 */
export type GitCmdRunner = (args: readonly string[], cwd: string) => Promise<string>;

export class RealGitRunner implements GitRunner {
  constructor(
    private readonly repoRoot: string,
    private readonly gitCmd: GitCmdRunner = defaultGitCmd,
  ) {}

  /**
   * `git fetch origin --prune` 拉最新 refs + objects 到本地. 砚砚 final review
   * P1 fix: production cron tick 前调一次, 保证 getCommitMeta 在 newly pushed
   * remote branches 上有 local objects 可用 (否则 `git show <sha>` 失败).
   */
  async prefetch(): Promise<void> {
    await this.gitCmd(['fetch', 'origin', '--prune'], this.repoRoot);
  }

  /**
   * `git ls-remote --heads origin` → 解析 refs/heads/* → 按 patterns 过滤。
   *
   * patterns 支持简单 glob（`*` → `.*`），如 `'fix/*'` / `'feat/*'`。
   */
  async lsRemote(branchPatterns: string[]): Promise<GitBranchRef[]> {
    if (branchPatterns.length === 0) return [];
    const output = await this.gitCmd(['ls-remote', '--heads', 'origin'], this.repoRoot);
    const refs: GitBranchRef[] = [];
    const compiledPatterns = branchPatterns.map(compileGlobPattern);
    for (const line of output.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // Format: <sha>\trefs/heads/<branchName>
      const parts = trimmed.split(/\s+/);
      if (parts.length < 2) continue;
      const sha = parts[0];
      const ref = parts[1];
      if (!ref.startsWith('refs/heads/')) continue;
      const branchName = ref.slice('refs/heads/'.length);
      if (compiledPatterns.some((re) => re.test(branchName))) {
        refs.push({ branchName, headCommitSha: sha });
      }
    }
    return refs;
  }

  /**
   * `git show -s --format=%ct|%aE|%aN <sha>` → commit timestamp + author email + name
   * `git log --max-count=N --format=%s <branchName>` → recent commit messages
   *
   * `headCommitAt` 单位转 Unix ms（git %ct 是 Unix s）。
   * `authorIdentity` 优先从 email 提取 cat handle（opus-47 / opus-48 / codex 等），
   * fallback 用 name。
   */
  async getCommitMeta(sha: string, branchName: string): Promise<GitCommitMeta> {
    const showOutput = await this.gitCmd(['show', '-s', '--format=%ct|%aE|%aN', sha], this.repoRoot);
    const showLine = showOutput.trim().split('\n')[0] ?? '';
    const [tsStr, email, name] = showLine.split('|');
    const headCommitAt = Number(tsStr) * 1000; // s → ms
    if (!Number.isFinite(headCommitAt) || headCommitAt === 0) {
      throw new Error(`RealGitRunner.getCommitMeta: invalid timestamp from git show -s ${sha}: "${showLine}"`);
    }
    const fromEmail = extractCatHandle(email ?? '');
    const trimmedName = (name ?? '').trim();
    const fromName = trimmedName.length > 0 ? trimmedName : 'unknown';
    const authorIdentity = fromEmail ?? fromName;

    // 砚砚 re-review P1 fix: use SHA (always valid post-fetch) instead of bare
    // branch name. After `git fetch origin --prune`, remote-only branches exist
    // as `origin/<branchName>` (refs/remotes/origin/...), NOT as local <branchName>;
    // so `git log <branchName>` fails for any branch not yet checked out locally.
    // SHA is always valid + unambiguous + doesn't care about local ref namespace.
    //
    // Cloud round 1 P1 fix: `git log <sha>` alone walks the reachable history
    // from <sha> — which includes main's history when the branch shares ancestry.
    // Use `^origin/main` to exclude commits reachable from main, returning only
    // commits unique to this branch (the F-tag extraction heuristic this feeds
    // into wants per-branch context, not historical noise from main). Edge cases:
    // - Branch fully merged: returns empty → graceful, branchName F# heuristic still works
    // - Newly created branch with 0 unique commits: returns empty → same
    // - origin/main missing: would fail loud, but prefetch() above guarantees its presence
    //
    // (branchName param kept for future use / diagnostic context, no longer used in cmd.)
    void branchName;
    const logOutput = await this.gitCmd(['log', '--max-count=20', '--format=%s', sha, '^origin/main'], this.repoRoot);
    const commitMessages = logOutput
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);

    return { headCommitAt, authorIdentity, commitMessages };
  }
}

// ============================================================================
// Internals
// ============================================================================

/** Compile a simple glob ("fix/*") into a regex anchored full-match. */
function compileGlobPattern(pattern: string): RegExp {
  // Escape regex specials except `*`; then replace `*` with `.*`
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

/**
 * Extract Clowder AI cat handle from an email address. Conventional patterns:
 * - `<noreply>@anthropic.com` (Claude family) → cannot disambiguate; return null
 * - `opus-47@...` / `<anything>opus-47<anything>@...` → 'opus-47'
 * - `<noreply>@codex.openai.com` → 'codex' (砚砚)
 * - Co-Authored-By footer signs commits with `Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>`
 *   so authorEmail is often `noreply@anthropic.com` — caller may fall back to display name.
 *
 * Returns null when email doesn't match any known cat handle, so caller can fall
 * back to display name.
 */
function extractCatHandle(email: string): string | null {
  const lower = email.toLowerCase();
  if (lower.includes('opus-47')) return 'opus-47';
  if (lower.includes('opus-48')) return 'opus-48';
  if (lower.includes('opus-46')) return 'opus-46';
  if (lower.includes('fable')) return 'fable';
  if (lower.includes('codex')) return 'codex';
  if (lower.includes('gpt52') || lower.includes('gpt-5.2') || lower.includes('gpt-5.4')) return 'gpt52';
  if (lower.includes('sonnet')) return 'sonnet';
  if (lower.includes('gemini35') || lower.includes('gemini-3.5')) return 'gemini35';
  if (lower.includes('gemini')) return 'gemini';
  // 'opus' generic last (less specific than opus-XX)
  if (lower.includes('opus')) return 'opus';
  return null;
}

/** Default real spawn-based git command runner (production). */
const defaultGitCmd: GitCmdRunner = (args, cwd) =>
  new Promise((resolve, reject) => {
    const proc = spawn('git', args as readonly string[], {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
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
      else reject(new Error(`git ${args.join(' ')} exited ${code}: ${stderr.trim()}`));
    });
  });

// Internal exports for tests
export const __internal = { compileGlobPattern, extractCatHandle };
