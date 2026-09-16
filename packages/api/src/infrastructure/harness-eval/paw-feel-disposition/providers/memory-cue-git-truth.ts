import { execFileSync } from 'node:child_process';

const FULL_GIT_COMMIT = /^[0-9a-f]{40}$/;
const OUTCOME_LIFECYCLE_PATHS = Object.freeze([
  'packages/api/src/domains/memory/cue/MemoryCueEpisodeStore.ts',
  'packages/api/src/domains/memory/schema.ts',
  'packages/api/src/routes/callback-memory-cue-routes.ts',
  'packages/mcp-server/src/tools/memory-cue-tools.ts',
  'packages/shared/src/types/memory-cue.ts',
  'packages/shared/src/recall-outcome.ts',
]);

export interface MemoryCuePawFeelGitTruth {
  readonly loadedRevision: string | null;
  currentMainRevision(): Promise<string | null>;
  isAncestor(ancestor: string, descendant: string): Promise<boolean>;
  changedFiles(fromRevision: string, toRevision: string): Promise<readonly string[]>;
}

export function canonicalMemoryCueGitCommit(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized && FULL_GIT_COMMIT.test(normalized) ? normalized : null;
}

export function assertMemoryCueGitCommit(value: string): string {
  const commit = canonicalMemoryCueGitCommit(value);
  if (!commit) throw new Error('memory-cue repair target is not a full Git commit');
  return commit;
}

export function isMemoryCueOutcomeLifecyclePath(path: string): boolean {
  return OUTCOME_LIFECYCLE_PATHS.includes(path);
}

function gitOutput(repoRoot: string, args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 5_000,
    maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function createMemoryCuePawFeelGitTruth(input: {
  repoRoot: string;
  loadedRevision: string | null;
}): MemoryCuePawFeelGitTruth {
  return {
    loadedRevision: canonicalMemoryCueGitCommit(input.loadedRevision),
    async currentMainRevision() {
      try {
        return canonicalMemoryCueGitCommit(
          gitOutput(input.repoRoot, ['rev-parse', '--verify', 'refs/remotes/origin/main^{commit}']),
        );
      } catch {
        return null;
      }
    },
    async isAncestor(ancestor, descendant) {
      assertMemoryCueGitCommit(ancestor);
      assertMemoryCueGitCommit(descendant);
      try {
        gitOutput(input.repoRoot, ['merge-base', '--is-ancestor', ancestor, descendant]);
        return true;
      } catch (error) {
        if ((error as { status?: number }).status === 1) return false;
        throw error;
      }
    },
    async changedFiles(fromRevision, toRevision) {
      const from = assertMemoryCueGitCommit(fromRevision);
      const to = assertMemoryCueGitCommit(toRevision);
      const output = gitOutput(input.repoRoot, [
        'diff',
        '--name-only',
        '--no-renames',
        `${from}..${to}`,
        '--',
        ...OUTCOME_LIFECYCLE_PATHS,
      ]);
      return output
        ? output
            .split('\n')
            .map((path) => path.trim())
            .filter(Boolean)
        : [];
    },
  };
}
