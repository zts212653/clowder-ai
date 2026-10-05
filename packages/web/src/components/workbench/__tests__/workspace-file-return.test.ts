import { describe, expect, it } from 'vitest';
import { parseFileNavigationOrigin } from '../file-navigation-origin';
import { workspaceFileReturnAction } from '../workspace-file-return';

describe('ordinary Workspace file return actions', () => {
  it('returns a relative link to the original document worktree and line, irrespective of the target worktree', () => {
    const origin = {
      kind: 'workspace-document' as const,
      worktreeId: 'original-worktree',
      path: 'docs/original.md',
      line: 17,
    };
    expect(workspaceFileReturnAction(origin, 'different-target-worktree')).toEqual(origin);
  });
  it('returns a file-tree opened review to the exact worktree tree', () => {
    expect(workspaceFileReturnAction({ kind: 'file-tree' }, 'worktree-a')).toEqual({
      kind: 'file-tree',
      worktreeId: 'worktree-a',
    });
  });

  it('returns to the tree the file was opened from, even after the file surface is re-keyed to its canonical root', () => {
    // The tree browsed '71b6cb_scratch'; the opened file later canonicalises to an F063 root id.
    expect(workspaceFileReturnAction({ kind: 'file-tree', worktreeId: '71b6cb_scratch' }, 'f063_root_v1_abc')).toEqual({
      kind: 'file-tree',
      worktreeId: '71b6cb_scratch',
    });
  });

  it('returns to a tree with the listing coordinate it was minted under, never lending it to another id', () => {
    const origin = { kind: 'file-tree' as const, worktreeId: 'b603ff_alpha', repoRoot: '/repo/alpha' };
    expect(parseFileNavigationOrigin(origin)).toEqual(origin);
    expect(workspaceFileReturnAction(origin, 'f063_root_v1_abc')).toEqual(origin);
    expect(workspaceFileReturnAction({ kind: 'file-tree', repoRoot: '/repo/alpha' }, 'worktree-a')).toEqual({
      kind: 'file-tree',
      worktreeId: 'worktree-a',
    });
    expect(parseFileNavigationOrigin({ kind: 'file-tree', worktreeId: 'b603ff_alpha', repoRoot: '' })).toEqual({
      kind: 'file-tree',
      worktreeId: 'b603ff_alpha',
    });
  });

  it('keeps the browsing tree through descriptor persistence', () => {
    expect(parseFileNavigationOrigin({ kind: 'file-tree', worktreeId: '71b6cb_scratch' })).toEqual({
      kind: 'file-tree',
      worktreeId: '71b6cb_scratch',
    });
    expect(parseFileNavigationOrigin({ kind: 'file-tree' })).toEqual({ kind: 'file-tree' });
    expect(parseFileNavigationOrigin({ kind: 'file-tree', worktreeId: '' })).toEqual({ kind: 'file-tree' });
  });

  it('returns a Home-search opened review with the original query intact', () => {
    expect(workspaceFileReturnAction({ kind: 'workspace-home-search', query: 'F309 owner' }, 'worktree-a')).toEqual({
      kind: 'workspace-home-search',
      query: 'F309 owner',
    });
  });

  it('returns a chat-link opened review to the exact originating message', () => {
    expect(
      workspaceFileReturnAction(
        { kind: 'chat-file-link', threadId: 'thread-f309', messageId: 'message-file-link' },
        'worktree-a',
      ),
    ).toEqual({ kind: 'chat-file-link', threadId: 'thread-f309', messageId: 'message-file-link' });
  });
});
