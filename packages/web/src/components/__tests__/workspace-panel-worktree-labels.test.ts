import { describe, expect, it } from 'vitest';
import { worktreeLabel } from '@/utils/worktree-label';

describe('clowder-ai#1117: worktree selector labels', () => {
  it('keeps linked-root aliases when basenames collide', () => {
    const labelA = worktreeLabel({ head: 'linked', root: '/client-a/project', branch: 'client-a' });
    const labelB = worktreeLabel({ head: 'linked', root: '/client-b/project', branch: 'client-b' });

    expect(labelA).toBe('📂 project — client-a');
    expect(labelB).toBe('📂 project — client-b');
    expect(labelA).not.toBe(labelB);
  });

  it('shows worktree basename, branch and head', () => {
    expect(worktreeLabel({ head: 'abc123', root: '/workspace/feature-x', branch: 'feat/cool' })).toBe(
      'feature-x — feat/cool (abc123)',
    );
  });

  it('handles Windows-style paths', () => {
    expect(worktreeLabel({ head: 'linked', root: 'C:\\Users\\dev\\project', branch: 'dev-project' })).toBe(
      '📂 project — dev-project',
    );
  });
});
