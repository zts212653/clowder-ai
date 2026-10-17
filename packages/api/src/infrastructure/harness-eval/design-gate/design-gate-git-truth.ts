import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DesignGateGitTruth } from './design-gate-types.js';

const execFileAsync = promisify(execFile);

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
