'use client';
import type { ReactNode } from 'react';
import { resolveShellCopy, useShellCopy } from '@/components/shell/shell-copy';
import { readShellLanguage } from '@/components/shell/shell-language';
import { workspaceChromeCopy } from '@/components/workbench/workspace-chrome.shell-copy';
import { FileToolbar } from '../content-review/FileToolbar';
import { FileIcon } from './FileIcons';
import type { WorkspaceFileViewerProps } from './WorkspaceFileViewer.types';
import { WorkspaceToolbarButton as Button } from './WorkspaceToolbarButton';
import { workspaceFileCopy } from './workspace-file.shell-copy';

export function fileReturnLabel(origin: WorkspaceFileViewerProps['navigationOrigin']): string {
  const t = resolveShellCopy(workspaceFileCopy, readShellLanguage());
  if (origin?.kind === 'meeting-transcript') return `‹ ${t.meeting}`;
  if (origin?.kind === 'workspace-changes') return `‹ ${t.changes}`;
  if (origin?.kind === 'workspace-home-search' || origin?.kind === 'workspace-tools-search')
    return `‹ ${resolveShellCopy(workspaceChromeCopy, readShellLanguage()).toolsSearch}`;
  if (origin?.kind === 'workspace-home-artifact')
    return `‹ ${resolveShellCopy(workspaceChromeCopy, readShellLanguage()).home}`;
  if (origin?.kind === 'chat-file-link') return `‹ ${t.chat}`;
  if (origin?.kind === 'workspace-document') return `‹ ${t.document}`;
  if (origin?.kind === 'artifact-list') return `‹ ${t.works}`;
  return `‹ ${t.files}`;
}

function fileChromeBackLabel(p: Pick<WorkspaceFileViewerProps, 'navigationOrigin' | 'showFileQuotes'>): string {
  return fileReturnLabel(p.navigationOrigin);
}

/** Presentation only: content, editing, speech, navigation and annotations retain their owners. */
export function V2WorkspaceFileChrome({
  props: p,
  listen,
  cache,
  onAsk,
}: {
  props: WorkspaceFileViewerProps;
  listen: ReactNode;
  cache: ReactNode;
  onAsk: () => void;
}) {
  const t = useShellCopy(workspaceFileCopy);
  const path = p.openFilePath ?? p.file.path;
  const directory = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : t.root;
  const toggle =
    !p.editMode && (p.isMarkdown || p.isHtml || p.isJsx) ? (
      <Button
        onClick={p.isMarkdown ? p.onToggleMarkdownRendered : p.isHtml ? p.onToggleHtmlPreview : p.onToggleJsxPreview}
        title={t.toggle}
        activeClass="bg-cafe-accent text-[var(--cafe-accent-foreground)] hover:bg-cafe-accent-hover"
        active={p.isMarkdown ? p.markdownRendered : p.isHtml ? false : p.jsxPreview}
      >
        {p.isMarkdown
          ? p.markdownRendered
            ? t.rendered
            : t.source
          : p.isHtml
            ? p.htmlPreview
              ? t.viewSource
              : t.pagePreview
            : p.jsxPreview
              ? t.preview
              : t.source}
      </Button>
    ) : null;
  const secondaryActions = (
    <>
      <Button
        onClick={onAsk}
        disabled={p.modificationDisabled || (p.onRequestModification ? p.editMode : false)}
        title={t.askTitle}
      >
        {t.ask}
      </Button>
      {p.collaborationAvailable && p.onOpenCollaboration && (
        <Button
          onClick={p.onOpenCollaboration}
          disabled={p.editMode}
          title={p.editMode ? t.saveFirst : t.annotationTitle}
        >
          {p.collaborationLabel ?? t.annotations}
          {p.annotationCount != null ? ` ${p.annotationCount}` : ''}
        </Button>
      )}
    </>
  );
  return (
    <div
      hidden={p.focusMode}
      className={`${p.focusMode ? 'hidden' : 'block'} v2-file-chrome shrink-0`}
      data-testid="v2-file-chrome"
    >
      {!p.nestedWork ? (
        <div
          className="flex h-9 min-w-0 items-center border-b border-cafe-subtle bg-cafe-surface/60"
          data-testid="v2-file-tabs"
        >
          {p.onBack && !p.treeVisible && (
            <button
              type="button"
              onClick={p.onBack}
              data-testid="v2-file-back"
              className="shrink-0 border-r border-cafe-subtle px-3 py-2 text-xs font-semibold text-cafe-secondary"
            >
              {fileChromeBackLabel(p)}
            </button>
          )}
          <div className="flex min-w-0 flex-1 overflow-x-auto scrollbar-none">
            {p.openTabs.map((tab) => (
              <div
                key={tab}
                className={`group flex max-w-56 shrink-0 items-center border-r border-cafe-subtle text-xs ${tab === path ? 'bg-cafe-surface text-cafe-black' : 'text-cafe-muted'}`}
              >
                <button
                  type="button"
                  onClick={() => p.setOpenFile(tab)}
                  title={tab}
                  className="flex min-w-0 items-center gap-1.5 py-2 pl-3"
                >
                  <FileIcon name={tab} />
                  <span className="truncate">{tab.split('/').at(-1)}</span>
                </button>
                <button
                  type="button"
                  aria-label={t.close(tab.split('/').at(-1) ?? tab)}
                  className="mx-1 shrink-0 rounded px-1 hover:bg-cafe-surface-sunken"
                  onClick={() => p.closeTab(tab)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      <div data-testid="workspace-file-toolbar">
        <FileToolbar
          source={{ kind: 'workspace', worktreeId: p.worktreeId ?? '', path }}
          filename={path}
          mime={p.file.mime}
          byteLength={p.file.size}
          text={p.file.binary ? undefined : p.file.content}
          readOnlyReason={!p.canEdit ? '此来源没有文件写入权限' : undefined}
          leading={
            p.onBack && p.nestedWork ? (
              <Button onClick={p.onBack} title={t.returnTitle(path)}>
                {fileReturnLabel(p.navigationOrigin)}
              </Button>
            ) : undefined
          }
          location={
            <button
              type="button"
              data-testid="v2-file-directory"
              onClick={p.onRevealInTree}
              disabled={!p.onRevealInTree}
              title={t.reveal}
              className="block w-full truncate rounded px-1 py-1 text-left text-xs hover:bg-cafe-surface-sunken disabled:cursor-default"
            >
              {directory}
            </button>
          }
          controls={
            <>
              <span className="file-toolbar-view shrink-0">{toggle}</span>
              {p.canEdit && (
                <Button onClick={p.onToggleEdit} active={p.editMode} title={t.editTitle}>
                  {p.editMode ? t.editing : t.edit}
                </Button>
              )}
              <span className="file-toolbar-listen shrink-0">{listen}</span>
            </>
          }
          overflowControls={
            <>
              <div className="file-toolbar-menu-view">{toggle}</div>
              <div className="file-toolbar-menu-listen">{listen}</div>
              {secondaryActions}
              {cache}
            </>
          }
        />
      </div>
    </div>
  );
}
