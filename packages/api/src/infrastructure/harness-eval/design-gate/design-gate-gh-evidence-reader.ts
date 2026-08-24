import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { executeGh, type GhExecFileAsync } from '../../email/ci-status-fetcher.js';
import type {
  DesignGateGitTruth,
  DesignGatePullRequestEvidence,
  DesignGatePullRequestReader,
} from './design-gate-types.js';

const execFileAsync = promisify(execFile);
const PR_REF = /^github:pr:([^/\s]+\/[^#\s]+)#([1-9]\d*)$/;

export class GhDesignGatePullRequestReader implements DesignGatePullRequestReader {
  constructor(private readonly execFileOverride?: GhExecFileAsync) {}

  async resolve(ref: string): Promise<DesignGatePullRequestEvidence> {
    const match = PR_REF.exec(ref);
    if (!match) throw new Error(`invalid GitHub PR ref: ${ref}`);
    const [, repoFullName, prNumberText] = match;
    if (!repoFullName || !prNumberText) throw new Error(`invalid GitHub PR ref: ${ref}`);
    const prNumber = Number(prNumberText);
    const { stdout } = await executeGh(
      ['pr', 'view', String(prNumber), '-R', repoFullName, '--json', 'number,state,headRefOid,mergeCommit,body,files'],
      { ...(this.execFileOverride ? { execFileAsync: this.execFileOverride } : {}) },
    );
    const value = JSON.parse(stdout) as {
      number?: number;
      state?: string;
      headRefOid?: string;
      mergeCommit?: { oid?: string } | null;
      body?: string;
      files?: Array<{ path?: string }>;
    };
    if (value.number !== prNumber || !['OPEN', 'CLOSED', 'MERGED'].includes(value.state ?? '')) {
      throw new Error(`GitHub PR identity/state mismatch for ${ref}`);
    }
    if (!/^[0-9a-f]{40}$/.test(value.headRefOid ?? '')) throw new Error(`GitHub PR exact HEAD unavailable for ${ref}`);
    if (!Array.isArray(value.files) || value.files.some((file) => typeof file.path !== 'string')) {
      throw new Error(`GitHub PR changed files unavailable for ${ref}`);
    }
    return {
      repoFullName,
      number: prNumber,
      state: value.state as DesignGatePullRequestEvidence['state'],
      headSha: value.headRefOid as string,
      mergeSha: value.mergeCommit?.oid ?? null,
      body: value.body ?? '',
      changedFiles: value.files.map((file) => file.path as string),
    };
  }
}

export class GitDesignGateTruth implements DesignGateGitTruth {
  constructor(private readonly repoRoot: string) {}

  async isOriginMainAncestor(revision: string): Promise<boolean> {
    return this.isAncestor(revision, 'refs/remotes/origin/main');
  }

  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    try {
      await execFileAsync('git', ['-C', this.repoRoot, 'merge-base', '--is-ancestor', ancestor, descendant], {
        timeout: 15_000,
      });
      return true;
    } catch {
      return false;
    }
  }
}
