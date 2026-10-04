import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { withHiddenGhCliWindow } from '../../../github/gh-cli-env.js';
import type { VerdictCommitStatus } from '../types.js';

const exec = promisify(execFile);
const FULL_SHA = /^[a-f0-9]{40}$/;
const REPO_FULL_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export const EVAL_EVIDENCE_CONTRACT_CHECK_NAME = 'Eval Evidence Structural Contract';
const EVIDENCE_CONTRACT_SUCCESS_DESCRIPTION =
  'Candidate lifecycle-root, snapshot, provenance, and publication identity contracts passed';

export function verdictEvidenceContractSuccessStatuses(): VerdictCommitStatus[] {
  return [
    {
      context: EVAL_EVIDENCE_CONTRACT_CHECK_NAME,
      state: 'success',
      description: EVIDENCE_CONTRACT_SUCCESS_DESCRIPTION,
    },
  ];
}

export interface PublishVerdictCommitStatusesInput {
  repoFullName: string;
  headSha: string;
  statuses: VerdictCommitStatus[];
}

export type VerdictCommitStatusGhRunner = (args: string[]) => Promise<void>;

async function runGh(args: string[]): Promise<void> {
  await exec('gh', args, withHiddenGhCliWindow({ timeout: 30_000 }));
}

function validateInput(input: PublishVerdictCommitStatusesInput): void {
  if (!REPO_FULL_NAME.test(input.repoFullName)) throw new Error('invalid_verdict_status_repo');
  if (!FULL_SHA.test(input.headSha)) throw new Error('invalid_verdict_status_head_sha');
  for (const status of input.statuses) {
    if (!status.context.trim() || status.context.length > 100 || /[\r\n]/.test(status.context)) {
      throw new Error('invalid_verdict_status_context');
    }
    if (!status.description.trim() || status.description.length > 140 || /[\r\n]/.test(status.description)) {
      throw new Error('invalid_verdict_status_description');
    }
  }
}

export async function publishVerdictCommitStatuses(
  input: PublishVerdictCommitStatusesInput,
  runner: VerdictCommitStatusGhRunner = runGh,
): Promise<void> {
  validateInput(input);
  for (const status of input.statuses) {
    await runner([
      'api',
      '--method',
      'POST',
      `repos/${input.repoFullName}/statuses/${input.headSha}`,
      '--raw-field',
      `state=${status.state}`,
      '--raw-field',
      `context=${status.context}`,
      '--raw-field',
      `description=${status.description}`,
    ]);
  }
}
