/**
 * Regression test for #1117 — worktree selector labels.
 *
 * Imports the production worktreeLabel() from utils/worktree-label.ts
 * so that mutations to the production code are caught by these tests.
 */
import { describe, expect, it } from 'vitest';
import { worktreeLabel } from '@/utils/worktree-label';

describe('#1117: worktree selector labels', () => {
  it('linked roots with same basename but different aliases produce different labels', () => {
    const rootA = { head: 'linked', root: '/client-a/project', branch: 'client-a' };
    const rootB = { head: 'linked', root: '/client-b/project', branch: 'client-b' };

    const labelA = worktreeLabel(rootA);
    const labelB = worktreeLabel(rootB);

    expect(labelA).not.toBe(labelB);
    expect(labelA).toContain('client-a');
    expect(labelB).toContain('client-b');
    // Both show the basename for directory orientation
    expect(labelA).toContain('project');
    expect(labelB).toContain('project');
  });

  it('linked root label includes both basename and alias', () => {
    const root = { head: 'linked', root: '/path/to/my-app', branch: 'my-project' };
    const label = worktreeLabel(root);

    expect(label).toBe('📂 my-app — my-project');
  });

  it('worktree label shows basename, branch and head', () => {
    const wt = { head: 'abc123', root: '/workspace/github/feature-x', branch: 'feat/cool-thing' };
    const label = worktreeLabel(wt);

    expect(label).toBe('feature-x — feat/cool-thing (abc123)');
  });

  it('handles Windows-style backslash paths', () => {
    const root = { head: 'linked', root: 'C:\\Users\\dev\\project', branch: 'dev-project' };
    const label = worktreeLabel(root);

    expect(label).toBe('📂 project — dev-project');
  });
});
