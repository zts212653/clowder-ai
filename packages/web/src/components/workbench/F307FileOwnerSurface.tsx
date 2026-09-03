'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkspaceSurfaceDescriptor } from '@/components/workbench/workbench-contract';
import { WorkspaceFileViewer } from '@/components/workspace/WorkspaceFileViewer';
import { useFileEditing } from '@/hooks/useFileEditing';
import type { FileData } from '@/hooks/useWorkspace';
import { apiFetch } from '@/utils/api-client';
import { resolveFileTarget } from './real-surface-adapters';

interface FileOwnerTarget {
  worktreeId: string;
  path: string;
  scrollToLine: number | null;
}

function FileOwnerUnavailable({ message }: { message: string }) {
  return (
    <div className="grid h-full min-h-52 place-items-center p-6 text-center" data-testid="f307-owner-unavailable">
      <div>
        <p className="text-sm font-semibold text-cafe">这个文件目前无法恢复</p>
        <p className="mt-1 max-w-sm text-xs leading-5 text-cafe-muted">{message}</p>
      </div>
    </div>
  );
}

function ResolvedFileOwnerSurface({
  target,
  onRequestDetach,
}: {
  target: FileOwnerTarget;
  onRequestDetach: () => void;
}) {
  const [file, setFile] = useState<FileData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [markdownRendered, setMarkdownRendered] = useState(true);
  const [htmlPreview, setHtmlPreview] = useState(false);
  const [jsxPreview, setJsxPreview] = useState(false);
  const requestSeq = useRef(0);

  const fetchFile = useCallback(
    async (path: string) => {
      const seq = ++requestSeq.current;
      setLoading(true);
      setError(false);
      try {
        const params = new URLSearchParams({ worktreeId: target.worktreeId, path });
        const response = await apiFetch(`/api/workspace/file?${params}`);
        if (!response.ok) throw new Error(`workspace file owner unavailable: ${response.status}`);
        const nextFile = (await response.json()) as FileData;
        if (seq === requestSeq.current) setFile(nextFile);
      } catch {
        if (seq === requestSeq.current) {
          setFile(null);
          setError(true);
        }
      } finally {
        if (seq === requestSeq.current) setLoading(false);
      }
    },
    [target.worktreeId],
  );

  useEffect(() => {
    void fetchFile(target.path);
  }, [fetchFile, target.path]);

  const { editMode, setEditMode, saveError, canEdit, handleToggleEdit, handleSave } = useFileEditing({
    worktreeId: target.worktreeId,
    openFilePath: target.path,
    file,
    fetchFile,
  });

  const revealInFinder = useCallback(
    async (path: string) => {
      await apiFetch('/api/workspace/reveal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ worktreeId: target.worktreeId, path }),
      }).catch(() => undefined);
    },
    [target.worktreeId],
  );

  if (loading) return <div className="p-5 text-xs text-cafe-muted">正在从原 worktree 恢复文件…</div>;
  if (error || !file)
    return <FileOwnerUnavailable message="F063 文件 owner 暂时不可用；Workbench 没有改用当前 Workspace。" />;

  const isMarkdown = /\.mdx?$/i.test(target.path);
  const isHtml = /\.html?$/i.test(target.path);
  const isJsx = /\.[jt]sx$/i.test(target.path);
  return (
    <div className="flex min-h-0 flex-1" data-owner-worktree={target.worktreeId} data-owner-path={target.path}>
      <WorkspaceFileViewer
        file={file}
        openFilePath={target.path}
        openTabs={[target.path]}
        canEdit={canEdit}
        editMode={editMode}
        isMarkdown={isMarkdown}
        isHtml={isHtml}
        isJsx={isJsx}
        markdownRendered={markdownRendered}
        htmlPreview={htmlPreview}
        jsxPreview={jsxPreview}
        saveError={saveError}
        scrollToLine={target.scrollToLine}
        worktreeId={target.worktreeId}
        setOpenFile={() => undefined}
        closeTab={onRequestDetach}
        onCloseCurrentTab={() => {
          setEditMode(false);
          onRequestDetach();
        }}
        onToggleEdit={handleToggleEdit}
        onToggleMarkdownRendered={() => setMarkdownRendered((current) => !current)}
        onToggleHtmlPreview={() => setHtmlPreview((current) => !current)}
        onToggleJsxPreview={() => setJsxPreview((current) => !current)}
        onSave={handleSave}
        revealInFinder={revealInFinder}
      />
    </div>
  );
}

export function F307FileOwnerSurface({
  surface,
  onRequestDetach,
}: {
  surface: WorkspaceSurfaceDescriptor;
  onRequestDetach: () => void;
}) {
  const target = resolveFileTarget(surface);
  if (!target) return <FileOwnerUnavailable message="File descriptor 没有合法的 F063 owner/result target。" />;
  return <ResolvedFileOwnerSurface target={target} onRequestDetach={onRequestDetach} />;
}
