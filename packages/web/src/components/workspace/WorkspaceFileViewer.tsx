'use client';

import { fileContentKind } from '@cat-cafe/shared';
import { useCallback, useMemo, useRef, useState } from 'react';
import { createFileContextAttachment, createQuoteContextAttachment } from '@/components/chat-context-reference';
import { useChatStore } from '@/stores/chatStore';
import { API_URL } from '@/utils/api-client';
import { useArtworkChrome } from '../content-review/ArtworkChrome';
import { FileToolbar } from '../content-review/FileToolbar';
import { fileSourceIdentity } from '../content-review/file-action-client';
import { useShellPresentation } from '../shell/shell-presentation';
import { ClassicWorkspaceFileChrome } from './ClassicWorkspaceFileChrome';
import { FileContentRenderer } from './FileContentRenderer';
import { type MarkdownSelectionAction, useMarkdownSelectionAction } from './useMarkdownSelectionAction';
import { useWorkspaceListenMode } from './useWorkspaceListenMode';
import { V2WorkspaceFileChrome } from './V2WorkspaceFileChrome';
import { WorkspaceFilePreviewDraftNotice } from './WorkspaceFileDraftNotice';
import type { ContentDocumentViewerProps, WorkspaceFileViewerProps } from './WorkspaceFileViewer.types';
import { WorkspaceListenActions } from './WorkspaceListenActions';
import { addQuoteToChat, addWorkspaceFileQuoteToChat } from './workspace-file-quote';

export function WorkspaceFileViewer(props: WorkspaceFileViewerProps | ContentDocumentViewerProps) {
  const published = 'source' in props ? props : null;
  const workspace = 'source' in props ? null : props;
  const { file } = props;
  const kind = fileContentKind(file.path, file.mime);
  const [rendered, setRendered] = useState(kind === 'markdown' || kind === 'html');
  const chrome = useArtworkChrome();
  const mediaChrome = (kind === 'image' || kind === 'video') && !!chrome?.actions;
  const { openFilePath, editMode, markdownRendered, htmlPreview, jsxPreview, worktreeId, currentWorktree } =
    workspace ?? {
      openFilePath: file.path,
      editMode: false,
      isMarkdown: kind === 'markdown',
      markdownRendered: rendered,
      isHtml: kind === 'html',
      isJsx: kind === 'jsx',
      htmlPreview: rendered,
      jsxPreview: rendered,
      worktreeId: published?.source.kind === 'workspace' ? published.source.worktreeId : null,
      currentWorktree: undefined,
    };
  const isMarkdown = kind === 'markdown',
    isHtml = kind === 'html',
    isJsx = kind === 'jsx';
  const quoteSource = published?.source.kind === 'url' ? (published.quoteSource ?? false) : undefined;
  const source = published?.source ?? { kind: 'workspace' as const, worktreeId: worktreeId ?? '', path: file.path };
  const sourceKey = fileSourceIdentity(source);
  const listenReturn = useMemo(
    () => (published?.listenReturn ? { kind: 'artifact' as const, ...published.listenReturn } : undefined),
    [published?.listenReturn],
  );
  const isV2 = useShellPresentation() === 'v2';
  const currentThreadId = useChatStore((s) => s.currentThreadId);
  const onQuoteSelected = props.onQuoteSelected;
  const mdContainerRef = useRef<HTMLDivElement>(null);
  const mdSelectionAction = useMarkdownSelectionAction(
    mdContainerRef,
    isMarkdown && markdownRendered && !editMode && quoteSource !== false,
    sourceKey,
    // The loaded file's version, only when it is the file this tab names.
    file.path === openFilePath ? file.sha256 : null,
  );

  const handleMdAddToChat = useCallback(
    (action: MarkdownSelectionAction, comment: string) => {
      if (!openFilePath) return;
      if (quoteSource === false) return false;
      if (quoteSource) {
        if (quoteSource.artifactFile?.displayDigest !== `sha256:${action.version}`) return false;
        return (
          addQuoteToChat(
            currentThreadId,
            createQuoteContextAttachment(action.text, quoteSource, {
              comment,
              selectionStart: action.selectionStart,
              selectionEnd: action.selectionEnd,
            }),
          ).kind === 'added'
        );
      }
      const result = addWorkspaceFileQuoteToChat(currentThreadId, {
        text: action.text,
        comment,
        path: openFilePath,
        // The version the selected words were made in (taken with the selection), not the one on screen at save time.
        revision: action.version ?? null,
        worktreeId,
        branch: currentWorktree?.branch,
        language: 'markdown',
        selectionStart: action.selectionStart,
        selectionEnd: action.selectionEnd,
      });
      if (result.kind !== 'added') return false;
      onQuoteSelected?.('');
      return true;
    },
    [currentThreadId, currentWorktree, openFilePath, worktreeId, quoteSource, onQuoteSelected],
  );

  const rawUrl = (path: string) =>
    published
      ? published.source.kind === 'url'
        ? published.source.url
        : `${API_URL}/api/workspace/file/raw?${new URLSearchParams({ worktreeId: published.source.worktreeId, path: published.source.path })}`
      : `${API_URL}/api/workspace/file/raw?worktreeId=${encodeURIComponent(worktreeId ?? '')}&path=${encodeURIComponent(path)}`;
  const listenMode = useWorkspaceListenMode({
    file,
    openFilePath,
    worktreeId,
    enabled: isMarkdown && markdownRendered && !editMode && !file.truncated && !!file.sha256,
    sourceKey: source.kind === 'url' ? sourceKey : undefined,
    returnTarget: listenReturn,
  });

  const handleAskCat = () => {
    if (!workspace) return;
    if (workspace.onRequestModification) return workspace.onRequestModification();
    if (!openFilePath) return;
    useChatStore.getState().setPendingChatInsert({
      threadId: currentThreadId,
      text: '请帮我修改这份文件：',
      contextAttachments: [createFileContextAttachment(openFilePath, worktreeId)],
    });
  };
  const listenProps = {
    active: listenMode.active,
    cache: listenMode.cache,
    hasSentences: listenMode.sentences.length > 0,
    onCancelCache: listenMode.cancelCache,
    onStartCache: listenMode.startCache,
    onStartListen: () => listenMode.start(),
  };
  const listenAvailable = isMarkdown && markdownRendered && !editMode;
  const listenAction = listenAvailable ? <WorkspaceListenActions {...listenProps} action="listen" /> : null;
  const cacheAction = listenAvailable ? <WorkspaceListenActions {...listenProps} action="cache" /> : null;

  return (
    <div className="flex min-h-0 min-w-0 w-full flex-1 flex-col animate-fade-in" data-testid="workspace-file-viewer">
      {mediaChrome ? null : published ? (
        <FileToolbar
          source={published.source}
          filename={file.path}
          mime={file.mime}
          byteLength={file.size}
          text={file.binary ? undefined : file.content}
          readOnlyReason={published.readOnlyReason ?? '此来源没有文件写入权限'}
          leading={
            published.onBack && (
              <button type="button" className="shrink-0 text-xs" onClick={published.onBack}>
                返回来源
              </button>
            )
          }
          controls={
            <>
              {published.reviewAction}
              {(isMarkdown || isHtml || isJsx) && (
                <button
                  type="button"
                  className="shrink-0 rounded border border-cafe px-2 py-1 text-xs"
                  onClick={() => setRendered((value) => !value)}
                >
                  {rendered ? '源码' : '渲染'}
                </button>
              )}
              {listenAction}
              {cacheAction}
            </>
          }
        />
      ) : workspace && isV2 ? (
        <V2WorkspaceFileChrome
          props={{ ...workspace, isMarkdown, isHtml, isJsx }}
          listen={listenAction}
          cache={cacheAction}
          onAsk={handleAskCat}
        />
      ) : workspace ? (
        <ClassicWorkspaceFileChrome props={{ ...workspace, isMarkdown, isHtml, isJsx }} listenMode={listenMode} />
      ) : null}

      {workspace?.saveError && (
        <div className="px-3 py-1.5 text-micro text-conn-red-text bg-[var(--semantic-critical-surface)] border-b border-[var(--semantic-critical)]">
          {workspace.saveError}
        </div>
      )}

      {workspace?.pendingExternalSha && (
        <div className="px-3 py-1.5 text-micro text-conn-amber-text bg-[var(--semantic-warning-surface)] border-b border-[var(--semantic-warning)] flex items-center justify-between">
          <span>文件已被外部修改</span>
          <span className="flex gap-2">
            <button
              type="button"
              onClick={workspace.onApplyExternalChange}
              className="underline hover:text-conn-amber-text"
            >
              重新加载
            </button>
            <button
              type="button"
              onClick={workspace.onDismissExternalChange}
              className="underline hover:text-conn-amber-text"
            >
              忽略
            </button>
          </span>
        </div>
      )}

      {listenMode.previousVersion && (
        <p role="status" className="px-3 text-xs text-cafe-muted">
          听读的是此文档的旧版本；当前正文已更新。
        </p>
      )}
      {/* File content */}
      {workspace &&
        !editMode &&
        ((isMarkdown && markdownRendered) || (isHtml && htmlPreview) || (isJsx && jsxPreview)) && (
          <WorkspaceFilePreviewDraftNotice
            worktreeId={worktreeId}
            path={file.path}
            sha256={file.sha256}
            content={file.content}
          />
        )}
      <FileContentRenderer
        file={file}
        sourceKey={sourceKey}
        listenCacheKey={listenMode.activeCacheKey ?? listenMode.cacheKey}
        openFilePath={openFilePath}
        isMarkdown={isMarkdown}
        isHtml={isHtml}
        isJsx={isJsx}
        markdownRendered={markdownRendered}
        htmlPreview={htmlPreview}
        jsxPreview={jsxPreview}
        editMode={editMode}
        scrollToLine={props.scrollToLine ?? null}
        worktreeId={worktreeId}
        currentWorktree={currentWorktree}
        mdContainerRef={mdContainerRef}
        mdSelectionAction={mdSelectionAction}
        onMdAddToChat={handleMdAddToChat}
        onSave={workspace?.onSave}
        onDirtyChange={workspace?.onDirtyChange}
        rawUrl={rawUrl}
        restoreScrollTop={workspace?.restoreScrollTop}
        restoreKey={workspace?.restoreKey}
        onScrollTopChange={workspace?.onScrollTopChange}
        listenSentences={listenMode.active ? listenMode.sentences : undefined}
        activeListenAnchor={listenMode.activeAnchor}
        onListenSentenceStart={listenMode.active ? listenMode.start : undefined}
        showFileQuotes={props.showFileQuotes}
        onQuoteSelected={props.onQuoteSelected}
        quoteSource={quoteSource}
        publishedQuoteSource={published?.quoteSource}
      />

      {file.truncated && (
        <div className="px-3 py-1.5 text-micro text-conn-amber-text bg-[var(--ws-editor-bg)] border-t border-[var(--semantic-warning)]">
          文件已截断 (超过 1MB)
        </div>
      )}
    </div>
  );
}
