'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkspaceSurfaceDescriptor } from '@/components/workbench/workbench-contract';
import { WorkspaceFileViewer } from '@/components/workspace/WorkspaceFileViewer';
import { useFileEditing } from '@/hooks/useFileEditing';
import type { FileData } from '@/hooks/useWorkspace';
import { useWorkspaceFileChange } from '@/hooks/useWorkspaceFileChange';
import type { WorkspaceFileNavigationOrigin } from '@/stores/chat-types';
import { apiFetch } from '@/utils/api-client';
import { WorkspaceOfficeSurface } from './content-editor/WorkspaceOfficeSurface';
import { ContentLandingHeader } from './content-review/ContentLandingHeader';
import { WorkspaceContentReviewSurface } from './content-review/WorkspaceContentReviewSurface';
import { resolveFileTarget } from './real-surface-adapters';

interface FileOwnerTarget {
  worktreeId: string;
  path: string;
  scrollToLine: number | null;
}

/** F063 preview hashes are bare hex; the F309 owner port names the same digest. */
function toWorkspaceContentRevision(sha256: string): string {
  if (!sha256) return '';
  return sha256.startsWith('sha256:') ? sha256 : `sha256:${sha256}`;
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
  navigationOrigin,
  onBack,
}: {
  target: FileOwnerTarget;
  onRequestDetach: () => void;
  navigationOrigin?: WorkspaceFileNavigationOrigin;
  onBack: () => void;
}) {
  const [file, setFile] = useState<FileData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [markdownRendered, setMarkdownRendered] = useState(true);
  const [htmlPreview, setHtmlPreview] = useState(false);
  const [jsxPreview, setJsxPreview] = useState(false);
  const [collaborationOpen, setCollaborationOpen] = useState(true);
  const requestSeq = useRef(0);

  const fetchFile = useCallback(
    async (path: string, afterCurrentGet = false) => {
      const seq = ++requestSeq.current;
      setLoading(true);
      setError(false);
      try {
        const params = new URLSearchParams({ worktreeId: target.worktreeId, path });
        const response = await apiFetch(`/api/workspace/file?${params}`, undefined, { afterCurrentGet });
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

  const refreshFile = useCallback((path: string) => fetchFile(path, true), [fetchFile]);

  useEffect(() => {
    void fetchFile(target.path);
  }, [fetchFile, target.path]);

  const { editMode, setEditMode, saveError, canEdit, handleToggleEdit, handleSave } = useFileEditing({
    worktreeId: target.worktreeId,
    openFilePath: target.path,
    file,
    fetchFile: refreshFile,
  });
  const { pendingExternalSha, onDirtyChange, applyExternalChange, dismissExternalChange } = useWorkspaceFileChange({
    worktreeId: target.worktreeId,
    path: target.path,
    currentSha: file?.sha256 ?? null,
    onReload: refreshFile,
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

  if (loading || error || !file)
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <ContentLandingHeader
          title={target.path.split('/').at(-1) || target.path}
          navigationOrigin={navigationOrigin}
          onBack={onBack}
        />
        {loading ? (
          <p className="p-5 text-xs text-cafe-muted">正在读取文件…</p>
        ) : (
          <>
            <FileOwnerUnavailable message="暂时无法读取此文件。请核对文件位置或访问权限。" />
            <button
              type="button"
              className="mx-auto mb-4 text-sm text-cafe-accent"
              onClick={() => void fetchFile(target.path)}
            >
              重新读取
            </button>
          </>
        )}
      </div>
    );

  const isMarkdown = /\.mdx?$/i.test(target.path);
  const isHtml = /\.html?$/i.test(target.path);
  const isJsx = /\.[jt]sx$/i.test(target.path);
  const isCollaborativeText = isMarkdown || /\.txt$/i.test(target.path) || canEdit;
  const collaborationAvailable =
    (isCollaborativeText && !file.truncated) || file.mime === 'image/png' || file.mime === 'video/mp4';
  if (collaborationOpen && collaborationAvailable)
    return (
      <WorkspaceContentReviewSurface
        worktreeId={target.worktreeId}
        path={target.path}
        sourceText={file.content}
        sourceTextRevision={toWorkspaceContentRevision(file.sha256)}
        scrollToLine={target.scrollToLine}
        navigationOrigin={navigationOrigin}
        onApplied={() => refreshFile(target.path)}
        onOpenFileTools={() => setCollaborationOpen(false)}
        onBack={onBack}
      />
    );
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
        collaborationAvailable={collaborationAvailable}
        onOpenCollaboration={() => setCollaborationOpen(true)}
        onSave={handleSave}
        onDirtyChange={onDirtyChange}
        pendingExternalSha={pendingExternalSha}
        onApplyExternalChange={applyExternalChange}
        onDismissExternalChange={dismissExternalChange}
        revealInFinder={revealInFinder}
      />
    </div>
  );
}

export function F307FileOwnerSurface({
  surface,
  onRequestDetach,
  onReturnToNavigationOrigin,
}: {
  surface: WorkspaceSurfaceDescriptor;
  onRequestDetach: () => void;
  onReturnToNavigationOrigin?: (origin: WorkspaceFileNavigationOrigin) => void;
}) {
  const target = resolveFileTarget(surface);
  if (!target)
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <ContentLandingHeader title={surface.title} onBack={onRequestDetach} />
        <FileOwnerUnavailable message="文件引用已不可用，请返回来源重新打开。" />
      </div>
    );
  const onBack = () =>
    surface.returnTargetRef
      ? onRequestDetach()
      : onReturnToNavigationOrigin
        ? onReturnToNavigationOrigin(surface.navigationOrigin ?? { kind: 'file-tree' })
        : onRequestDetach();
  if (/\.docx$/i.test(target.path))
    return (
      <WorkspaceOfficeSurface
        key={`${target.worktreeId}:${target.path}`}
        worktreeId={target.worktreeId}
        path={target.path}
        navigationOrigin={surface.navigationOrigin}
        onBack={onBack}
      />
    );
  return (
    <ResolvedFileOwnerSurface
      key={`${target.worktreeId}:${target.path}`}
      target={target}
      onRequestDetach={onRequestDetach}
      navigationOrigin={surface.navigationOrigin}
      onBack={onBack}
    />
  );
}
