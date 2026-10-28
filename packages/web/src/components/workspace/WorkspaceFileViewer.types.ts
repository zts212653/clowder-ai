import type { MessageQuoteSource, ThreadArtifactDTO } from '@cat-cafe/shared';
import type { ReactNode } from 'react';
import type { FileData, WorktreeEntry } from '@/hooks/useWorkspace';
import type { WorkspaceFileNavigationOrigin } from '@/stores/chat-types';
import type { FileActionSource } from '../content-review/file-action-client';
import type { WorkspaceFileSave } from './workspace-file-draft';

/** Read-only is a capability, not a separate document reader. */
export interface ContentDocumentViewerProps {
  file: FileData;
  source: FileActionSource;
  quoteSource?: MessageQuoteSource;
  readOnlyReason?: string;
  onBack?: () => void;
  reviewAction?: ReactNode;
  /** An owner-backed source retains its own public quote/annotation authority. */
  onOwnerQuote?: (action: import('./useMarkdownSelectionAction').MarkdownSelectionAction, comment: string) => boolean;
  ownerQuoteLabel?: string;
  showFileQuotes?: boolean;
  scrollToLine?: number | null;
  onQuoteSelected?: (quote: string) => void;
  listenReturn?: { threadId: string; artifact: ThreadArtifactDTO };
}

export interface WorkspaceFileViewerProps {
  file: FileData;
  openFilePath: string | null;
  openTabs: string[];
  canEdit: boolean;
  editMode: boolean;
  isMarkdown: boolean;
  isHtml: boolean;
  isJsx: boolean;
  markdownRendered: boolean;
  htmlPreview: boolean;
  jsxPreview: boolean;
  saveError: string | null;
  scrollToLine: number | null;
  worktreeId: string | null;
  currentWorktree?: WorktreeEntry;
  setOpenFile: (path: string) => void;
  closeTab: (path: string) => void;
  onCloseCurrentTab: () => void;
  onToggleEdit: () => void;
  onToggleMarkdownRendered: () => void;
  onToggleHtmlPreview: () => void;
  onToggleJsxPreview: () => void;
  collaborationAvailable?: boolean;
  collaborationLabel?: string;
  onOpenCollaboration?: () => void;
  onSave: WorkspaceFileSave;
  onDirtyChange?: (dirty: boolean) => void;
  pendingExternalSha?: string | null;
  onApplyExternalChange?: () => void;
  onDismissExternalChange?: () => void;
  onFocusMode?: () => void;
  focusDisabled?: boolean;
  restoreScrollTop?: number | null;
  restoreKey?: string;
  onScrollTopChange?: (scrollTop: number) => void;
  focusMode?: boolean;
  navigationOrigin?: WorkspaceFileNavigationOrigin;
  onBack?: () => void;
  onRevealInTree?: () => void;
  annotationCount?: number | null;
  treeVisible?: boolean;
  onRequestModification?: () => void;
  modificationDisabled?: boolean;
  onQuoteSelected?: (quote: string) => void;
  showFileQuotes?: boolean;
  /** The Workspace working set already presents the file tab. */
  nestedWork?: boolean;
}
