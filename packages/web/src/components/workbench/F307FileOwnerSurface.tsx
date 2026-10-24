'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { mediaChatMime } from '@/components/content-review/media-chat-selection';
import { modificationFocusStanding, usePendingModificationFocus } from '@/components/content-review/modification-focus';
import { useShellPresentation } from '@/components/shell/shell-presentation';
import type { WorkspaceSurfaceDescriptor } from '@/components/workbench/workbench-contract';
import { WorkspaceFileViewer } from '@/components/workspace/WorkspaceFileViewer';
import { useFileEditing } from '@/hooks/useFileEditing';
import type { FileData } from '@/hooks/useWorkspace';
import { useWorkspaceFileChange } from '@/hooks/useWorkspaceFileChange';
import type { WorkspaceFileNavigationOrigin } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { isWorkspaceArtworkPath } from './artifact-work-presentation';
import { WorkspaceOfficeSurface } from './content-editor/WorkspaceOfficeSurface';
import { ContentLandingHeader } from './content-review/ContentLandingHeader';
import type { ContentFileReaderControls } from './content-review/ContentReviewSurface';
import { WorkspaceContentReviewSurface } from './content-review/WorkspaceContentReviewSurface';
import { useF307ExperienceWorkbenchStore } from './experience-workbench-store';
import { createFilesSurface, resolveFileTarget } from './real-surface-adapters';
import { useWorkspaceFileViewport } from './useWorkspaceFileViewport';
import { promoteWorkspacePreview } from './WorkspacePreviewIntent';

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
    <div
      className="grid h-full min-h-52 place-items-center p-6 text-center"
      data-testid="f307-owner-unavailable"
      data-content-opening-state="blocked"
    >
      <div>
        <p className="text-sm font-semibold text-cafe">这个文件目前无法恢复</p>
        <p className="mt-1 max-w-sm text-xs leading-5 text-cafe-muted">{message}</p>
      </div>
    </div>
  );
}

function ResolvedFileOwnerSurface({
  surfaceId,
  target,
  onRequestDetach,
  navigationOrigin,
  onBack,
  onRevealInTree,
  focusMode = false,
}: {
  surfaceId: string;
  target: FileOwnerTarget;
  onRequestDetach: () => void;
  navigationOrigin?: WorkspaceFileNavigationOrigin;
  onBack: () => void;
  onRevealInTree: () => void;
  focusMode?: boolean;
}) {
  const isV2 = useShellPresentation() === 'v2';
  const viewport = useWorkspaceFileViewport(surfaceId, target);
  const [file, setFile] = useState<FileData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [markdownRendered, setMarkdownRendered] = useState(true);
  const [htmlPreview, setHtmlPreview] = useState(false);
  const [jsxPreview, setJsxPreview] = useState(false);
  const [collaborationOpen, setCollaborationOpen] = useState<boolean | null>(null);
  const requestSeq = useRef(0);
  const pendingFocus = usePendingModificationFocus();
  const currentThreadId = useChatStore((state) => state.currentThreadId);
  const openRevision = useChatStore((state) => state.workspaceOpenRevision);

  useEffect(() => {
    if (!pendingFocus) return;
    if (modificationFocusStanding(pendingFocus, { threadId: currentThreadId, revision: openRevision }) !== 'ours')
      return;
    const source = pendingFocus.record.payload.source;
    if (
      source.kind !== 'workspace' ||
      source.locator.worktreeId !== target.worktreeId ||
      source.locator.path !== target.path
    )
      return;
    // Mount the review consumer even on a cold/ordinary file tab. It alone verifies owner/version and takes the focus.
    setCollaborationOpen(true);
  }, [pendingFocus, currentThreadId, openRevision, target.worktreeId, target.path]);

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

  // Refresh this file in place: unmounting its collaboration surface loses the confirmed result and selection.
  // A different file or a denied read still has no cached preview to show.
  if (error || !file || file.path !== target.path)
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
  const collaborationAvailable = (isCollaborativeText && !file.truncated) || !!mediaChatMime(file.mime ?? '');
  const fileReader = (controls?: ContentFileReaderControls, collaborationRefusal?: string) => (
    <div className="flex min-h-0 flex-1 flex-col" data-owner-worktree={target.worktreeId} data-owner-path={target.path}>
      {isV2 && (collaborationRefusal || (/^(image|video)\//.test(file.mime ?? '') && !collaborationAvailable)) ? (
        <output className="shrink-0 px-3 py-2 text-xs text-cafe-muted">
          {collaborationRefusal ?? '这份媒体可以查看；当前格式尚不支持批注。'}
        </output>
      ) : null}
      <WorkspaceFileViewer
        {...viewport}
        nestedWork={isV2}
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
        onToggleEdit={() => {
          promoteWorkspacePreview(surfaceId);
          handleToggleEdit();
        }}
        onToggleMarkdownRendered={() => setMarkdownRendered((current) => !current)}
        onToggleHtmlPreview={() => setHtmlPreview((current) => !current)}
        onToggleJsxPreview={() => setJsxPreview((current) => !current)}
        showFileQuotes={!!controls}
        onQuoteSelected={controls?.onQuoteSelected}
        onRequestModification={controls?.onRequestModification}
        modificationDisabled={controls?.modificationDisabled}
        collaborationAvailable={!controls && !collaborationRefusal && collaborationAvailable}
        onOpenCollaboration={() => {
          promoteWorkspacePreview(surfaceId);
          setCollaborationOpen(true);
        }}
        onSave={handleSave}
        onDirtyChange={onDirtyChange}
        pendingExternalSha={pendingExternalSha}
        onApplyExternalChange={applyExternalChange}
        onDismissExternalChange={dismissExternalChange}
        revealInFinder={revealInFinder}
        focusMode={focusMode}
        navigationOrigin={navigationOrigin}
        onBack={onBack}
        onRevealInTree={onRevealInTree}
      />
    </div>
  );
  if (
    (isMarkdown && !file.truncated) ||
    ((collaborationOpen ?? (!isV2 || isWorkspaceArtworkPath(target.path))) && collaborationAvailable)
  )
    return (
      <WorkspaceContentReviewSurface
        worktreeId={target.worktreeId}
        path={target.path}
        sourceText={file.content}
        sourceTextRevision={toWorkspaceContentRevision(file.sha256)}
        scrollToLine={target.scrollToLine}
        navigationOrigin={navigationOrigin}
        onApplied={() => refreshFile(target.path)}
        oversizedVideoReader={
          isV2 && file.mime.startsWith('video/') ? (reason) => fileReader(undefined, reason) : undefined
        }
        {...(isMarkdown ? { fileReader } : { onOpenFileTools: () => setCollaborationOpen(false) })}
        onBack={onBack}
      />
    );
  return fileReader();
}

export function F307FileOwnerSurface({
  surface,
  onRequestDetach,
  onReturnToNavigationOrigin,
  focusMode = false,
}: {
  surface: WorkspaceSurfaceDescriptor;
  onRequestDetach: () => void;
  onReturnToNavigationOrigin?: (origin: WorkspaceFileNavigationOrigin) => void;
  focusMode?: boolean;
}) {
  const target = resolveFileTarget(surface);
  if (!target)
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <ContentLandingHeader title={surface.title} onBack={onRequestDetach} />
        <FileOwnerUnavailable message="文件引用已不可用，请返回来源重新打开。" />
      </div>
    );
  const onRevealInTree = () => {
    const origin = surface.navigationOrigin;
    // File resolution may re-key its owner; the browsed tree keeps the coordinate that listed it.
    const treeWorktreeId = origin?.kind === 'file-tree' ? (origin.worktreeId ?? target.worktreeId) : target.worktreeId;
    const files = createFilesSurface(treeWorktreeId, {
      ...(origin?.kind === 'file-tree' && origin.repoRoot ? { repoRoot: origin.repoRoot } : {}),
    });
    const workbench = useF307ExperienceWorkbenchStore.getState();
    const previousRequest =
      workbench.layout.surfaces.find((current) => current.id === files.id)?.filesReveal?.request ?? 0;
    workbench.dispatch({
      type: 'open-surface',
      surface: {
        ...files,
        filesReveal: { path: target.path, request: previousRequest + 1 },
        ...(surface.rootSelection ? { rootSelection: surface.rootSelection } : {}),
      },
      entitlement: { kind: 'user', reason: 'workspace-home-selection' },
    });
  };
  const onBack = () =>
    surface.returnTargetRef
      ? onRequestDetach()
      : onReturnToNavigationOrigin
        ? onReturnToNavigationOrigin(surface.navigationOrigin ?? { kind: 'file-tree' })
        : onRequestDetach();
  if (/\.docx$/i.test(target.path) && surface.navigationOrigin?.kind !== 'chat-file-link')
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
      surfaceId={surface.id}
      key={`${target.worktreeId}:${target.path}`}
      target={target}
      onRequestDetach={onRequestDetach}
      navigationOrigin={surface.navigationOrigin}
      onBack={onBack}
      onRevealInTree={onRevealInTree}
      focusMode={focusMode}
    />
  );
}
