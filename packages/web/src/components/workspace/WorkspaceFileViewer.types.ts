import type { FileData, WorktreeEntry } from '@/hooks/useWorkspace';

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
  onSave: (content: string) => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
  pendingExternalSha?: string | null;
  onApplyExternalChange?: () => void;
  onDismissExternalChange?: () => void;
  revealInFinder: (path: string) => void;
  onFocusMode?: () => void;
  focusDisabled?: boolean;
  restoreScrollTop?: number | null;
  restoreKey?: string;
  onScrollTopChange?: (scrollTop: number) => void;
}
