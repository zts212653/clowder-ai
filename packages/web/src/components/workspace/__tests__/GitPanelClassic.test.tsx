import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeShellPresentation } from '@/components/shell/shell-presentation';
import { GitPanel } from '../GitPanel';

Object.assign(globalThis as Record<string, unknown>, { React });

vi.mock('../../../hooks/useGitPanel', () => ({
  useGitPanel: () => ({
    commits: [],
    status: {
      isGitRepository: false,
      branch: '',
      staged: [],
      unstaged: [],
      untracked: [],
    },
    commitDetail: null,
    loading: false,
    error: null,
    fetchCommitDetail: () => {},
    refresh: () => {},
  }),
}));

vi.mock('../../../hooks/useGitHealth', () => ({
  useGitHealth: () => ({
    health: { isGitRepository: false, staleBranches: [], worktrees: [], runtimeDrift: null },
    loading: false,
    error: null,
    fetchHealth: () => {},
  }),
}));

describe('GitPanel classic non-git state', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    writeShellPresentation('classic');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    writeShellPresentation('classic');
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('shows repository-missing instead of clean/no-issues', async () => {
    await act(async () => {
      root.render(<GitPanel />);
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });
    expect(container.textContent).toContain('Not a Git repository');
    expect(container.textContent).not.toContain('Working tree clean');
    expect(container.textContent).not.toContain('All clean!');
  });
});
