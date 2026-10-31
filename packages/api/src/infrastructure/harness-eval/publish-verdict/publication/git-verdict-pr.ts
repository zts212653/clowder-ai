import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { withHiddenGhCliWindow } from '../../../github/gh-cli-env.js';

const exec = promisify(execFile);

const STANDARD_LABEL_META: Record<string, { color: string; description: string }> = {
  'evidence-only': {
    color: '0E8A16',
    description: 'F192 auto-verdict artifact PR — cat-owned merge per SOP, not operator',
  },
  'no-action-needed': {
    color: 'C5DEF5',
    description: 'F192 keep_observe + no actionable findings — interim per-run PR (rollup deferred)',
  },
};

export function withGitHubRepoScope(args: string[], expectedRepoFullName: string): string[] {
  return [...args, '--repo', expectedRepoFullName];
}

export async function openAutoVerdictPr(input: {
  expectedRepoFullName: string;
  worktreePath: string;
  branchName: string;
  title: string;
  body: string;
  labels?: string[];
}): Promise<string> {
  for (const label of input.labels ?? []) {
    const meta = STANDARD_LABEL_META[label];
    const args = ['label', 'create', label, '--force'];
    if (meta) args.push('--color', meta.color, '--description', meta.description);
    try {
      await exec(
        'gh',
        withGitHubRepoScope(args, input.expectedRepoFullName),
        withHiddenGhCliWindow({ cwd: input.worktreePath, timeout: 15_000 }),
      );
    } catch (error) {
      // PR creation below is authoritative for whether a label failure matters.
      void error;
    }
  }

  const labelFlags = (input.labels ?? []).flatMap((label) => ['--label', label]);
  const result = await exec(
    'gh',
    withGitHubRepoScope(
      [
        'pr',
        'create',
        '--base',
        'main',
        '--head',
        input.branchName,
        '--title',
        input.title,
        '--body',
        input.body,
        ...labelFlags,
      ],
      input.expectedRepoFullName,
    ),
    withHiddenGhCliWindow({ cwd: input.worktreePath, timeout: 60_000 }),
  );
  return (
    result.stdout
      .trim()
      .split('\n')
      .find((line) => line.startsWith('https://')) ?? result.stdout.trim()
  );
}

export async function closeAutoVerdictPr(input: {
  expectedRepoFullName: string;
  worktreePath: string;
  prUrl: string;
}): Promise<void> {
  await exec(
    'gh',
    withGitHubRepoScope(
      [
        'pr',
        'close',
        input.prUrl,
        '--delete-branch',
        '--comment',
        'Closing stale auto-verdict PR because post-publish writeback failed.',
      ],
      input.expectedRepoFullName,
    ),
    withHiddenGhCliWindow({ cwd: input.worktreePath, timeout: 60_000 }),
  );
}
