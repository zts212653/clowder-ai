import { describe, expect, it, vi } from 'vitest';

/**
 * Tests the file-change handler decision logic from useWorkspace.
 * We extract the core logic to test without needing full React/socket mocking.
 */

interface FileChangedEvent {
  worktreeId: string;
  path: string;
  sha256: string;
}

function createFileChangeHandler(opts: {
  openFilePath: string;
  worktreeId: string;
  fileShaRef: { current: string | null };
  editDirtyRef: { current: boolean };
  fetchFile: (path: string) => void;
  setPendingExternalSha: (sha: string) => void;
}) {
  return (data: FileChangedEvent) => {
    if (data.path !== opts.openFilePath || data.worktreeId !== opts.worktreeId) return;
    if (data.sha256 === opts.fileShaRef.current) return;
    if (opts.editDirtyRef.current) {
      opts.setPendingExternalSha(data.sha256);
    } else {
      opts.fetchFile(opts.openFilePath);
    }
  };
}

describe('useWorkspace file-change handler', () => {
  it('auto-reloads when not dirty and sha differs', () => {
    const fetchFile = vi.fn();
    const setPendingExternalSha = vi.fn();

    const handler = createFileChangeHandler({
      openFilePath: 'README.md',
      worktreeId: 'wt-1',
      fileShaRef: { current: 'sha-old' },
      editDirtyRef: { current: false },
      fetchFile,
      setPendingExternalSha,
    });

    handler({ worktreeId: 'wt-1', path: 'README.md', sha256: 'sha-new' });

    expect(fetchFile).toHaveBeenCalledWith('README.md');
    expect(setPendingExternalSha).not.toHaveBeenCalled();
  });

  it('sets pendingExternalSha when dirty and sha differs', () => {
    const fetchFile = vi.fn();
    const setPendingExternalSha = vi.fn();

    const handler = createFileChangeHandler({
      openFilePath: 'README.md',
      worktreeId: 'wt-1',
      fileShaRef: { current: 'sha-old' },
      editDirtyRef: { current: true },
      fetchFile,
      setPendingExternalSha,
    });

    handler({ worktreeId: 'wt-1', path: 'README.md', sha256: 'sha-new' });

    expect(setPendingExternalSha).toHaveBeenCalledWith('sha-new');
    expect(fetchFile).not.toHaveBeenCalled();
  });

  it('ignores event when sha matches current', () => {
    const fetchFile = vi.fn();
    const setPendingExternalSha = vi.fn();

    const handler = createFileChangeHandler({
      openFilePath: 'README.md',
      worktreeId: 'wt-1',
      fileShaRef: { current: 'sha-same' },
      editDirtyRef: { current: false },
      fetchFile,
      setPendingExternalSha,
    });

    handler({ worktreeId: 'wt-1', path: 'README.md', sha256: 'sha-same' });

    expect(fetchFile).not.toHaveBeenCalled();
    expect(setPendingExternalSha).not.toHaveBeenCalled();
  });

  it('ignores event for different file path', () => {
    const fetchFile = vi.fn();
    const setPendingExternalSha = vi.fn();

    const handler = createFileChangeHandler({
      openFilePath: 'README.md',
      worktreeId: 'wt-1',
      fileShaRef: { current: 'sha-old' },
      editDirtyRef: { current: false },
      fetchFile,
      setPendingExternalSha,
    });

    handler({ worktreeId: 'wt-1', path: 'other-file.ts', sha256: 'sha-new' });

    expect(fetchFile).not.toHaveBeenCalled();
    expect(setPendingExternalSha).not.toHaveBeenCalled();
  });

  it('ignores event for different worktreeId', () => {
    const fetchFile = vi.fn();
    const setPendingExternalSha = vi.fn();

    const handler = createFileChangeHandler({
      openFilePath: 'README.md',
      worktreeId: 'wt-1',
      fileShaRef: { current: 'sha-old' },
      editDirtyRef: { current: false },
      fetchFile,
      setPendingExternalSha,
    });

    handler({ worktreeId: 'wt-other', path: 'README.md', sha256: 'sha-new' });

    expect(fetchFile).not.toHaveBeenCalled();
    expect(setPendingExternalSha).not.toHaveBeenCalled();
  });

  it('auto-reloads when fileShaRef is null (initial load not complete) and sha differs', () => {
    const fetchFile = vi.fn();
    const setPendingExternalSha = vi.fn();

    const handler = createFileChangeHandler({
      openFilePath: 'README.md',
      worktreeId: 'wt-1',
      fileShaRef: { current: null },
      editDirtyRef: { current: false },
      fetchFile,
      setPendingExternalSha,
    });

    handler({ worktreeId: 'wt-1', path: 'README.md', sha256: 'sha-new' });

    expect(fetchFile).toHaveBeenCalledWith('README.md');
  });
});
