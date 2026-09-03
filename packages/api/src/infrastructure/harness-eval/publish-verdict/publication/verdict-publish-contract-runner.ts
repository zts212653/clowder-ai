import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export interface VerdictPublishContractInput {
  repoRoot: string;
  implementationRoot: string;
  expectedRepoFullName: string;
  remoteName: string;
  baseRef: string;
  sourceRef: string;
  identityOnly?: boolean;
}

export type VerdictPublishContractRunner = (input: VerdictPublishContractInput) => Promise<void>;

export async function runVerdictPublishContract(input: VerdictPublishContractInput): Promise<void> {
  const transportScript = resolve(input.repoRoot, 'scripts/check-verdict-publish-contract.mjs');
  await exec(
    process.execPath,
    [
      transportScript,
      '--repo-root',
      input.repoRoot,
      '--expected-repo',
      input.expectedRepoFullName,
      '--remote',
      input.remoteName,
      '--base-ref',
      input.baseRef,
      '--source-ref',
      input.sourceRef,
      ...(input.identityOnly ? ['--identity-only', 'true'] : []),
    ],
    { timeout: 60_000 },
  );

  if (!input.identityOnly && input.sourceRef === 'HEAD') {
    const evidenceScript = resolve(input.implementationRoot, 'scripts/check-verdict-evidence-contract.mjs');
    await exec(
      process.execPath,
      [
        evidenceScript,
        '--candidate-root',
        input.repoRoot,
        '--api-dist-root',
        resolve(input.implementationRoot, 'packages/api/dist'),
        '--git-root',
        input.repoRoot,
      ],
      { cwd: input.implementationRoot, timeout: 120_000 },
    );
  }
}
