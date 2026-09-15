import { execFileSync } from 'node:child_process';

const FULL_GIT_COMMIT = /^[0-9a-f]{40}$/;
const TASK_WORKFLOW_FILTER_PATHS = Object.freeze([
  'packages/api/src/domains/cats/services/stores/ports/TaskQuery.ts',
  'packages/api/src/routes/callback-task-routes.ts',
  'packages/mcp-server/src/tools/callback-tools.ts',
]);

export interface TaskWorkflowPawFeelGitTruth {
  readonly loadedRevision: string | null;
  currentMainRevision(): Promise<string | null>;
  isAncestor(ancestor: string, descendant: string): Promise<boolean>;
  changedFiles(fromRevision: string, toRevision: string): Promise<readonly string[]>;
}

export function canonicalTaskWorkflowGitCommit(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized && FULL_GIT_COMMIT.test(normalized) ? normalized : null;
}

export function assertTaskWorkflowGitCommit(value: string): string {
  const commit = canonicalTaskWorkflowGitCommit(value);
  if (!commit) throw new Error('task-workflow repair target is not a full Git commit');
  return commit;
}

export function isTaskWorkflowFeatureFilterPath(path: string): boolean {
  return TASK_WORKFLOW_FILTER_PATHS.includes(path);
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

export function createTaskWorkflowPawFeelGitTruth(input: {
  repoRoot: string;
  loadedRevision: string | null;
}): TaskWorkflowPawFeelGitTruth {
  return {
    loadedRevision: canonicalTaskWorkflowGitCommit(input.loadedRevision),
    async currentMainRevision() {
      try {
        return canonicalTaskWorkflowGitCommit(
          gitOutput(input.repoRoot, ['rev-parse', '--verify', 'refs/remotes/origin/main^{commit}']),
        );
      } catch {
        return null;
      }
    },
    async isAncestor(ancestor, descendant) {
      assertTaskWorkflowGitCommit(ancestor);
      assertTaskWorkflowGitCommit(descendant);
      try {
        gitOutput(input.repoRoot, ['merge-base', '--is-ancestor', ancestor, descendant]);
        return true;
      } catch (error) {
        if ((error as { status?: number }).status === 1) return false;
        throw error;
      }
    },
    async changedFiles(fromRevision, toRevision) {
      const from = assertTaskWorkflowGitCommit(fromRevision);
      const to = assertTaskWorkflowGitCommit(toRevision);
      const output = gitOutput(input.repoRoot, [
        'diff',
        '--name-only',
        '--no-renames',
        `${from}..${to}`,
        '--',
        ...TASK_WORKFLOW_FILTER_PATHS,
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
