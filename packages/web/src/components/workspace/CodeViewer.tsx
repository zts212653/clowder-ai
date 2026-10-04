import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { basicSetup, EditorView } from 'codemirror';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useWorkspaceSurfaceVisibility } from '@/components/workbench/WorkspaceSurfaceVisibility';
import { useChatStore } from '@/stores/chatStore';
import { SelectionAnnotationAction } from '../SelectionAnnotationAction';
import { type CodeSelectionAction, selectionActionForView } from './code-viewer-selection';
import { useWorkspaceFileDraft } from './useWorkspaceFileDraft';
import { WorkspaceFileDraftNotice } from './WorkspaceFileDraftNotice';
import type { WorkspaceFileSave } from './workspace-file-draft';
import { addWorkspaceFileQuoteToChat } from './workspace-file-quote';

const cafeTheme = EditorView.theme(
  {
    '&': { backgroundColor: 'var(--ws-editor-bg)', color: 'var(--ws-editor-fg)' },
    '.cm-gutters': {
      backgroundColor: 'var(--ws-editor-bg)',
      color: 'var(--ws-editor-gutter)',
      borderRight: '1px solid var(--ws-editor-surface)',
    },
    '.cm-activeLineGutter': { backgroundColor: 'var(--ws-editor-surface)' },
    '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--chart-5) 8%, transparent)' },
    '.cm-cursor': { borderLeftColor: 'var(--ws-accent)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
      backgroundColor: 'color-mix(in srgb, var(--chart-5) 25%, transparent) !important',
    },
    '.cm-line': { padding: '0 4px' },
  },
  { dark: true },
);

function getLanguageExtension(mime: string, path: string) {
  if (mime === 'text/typescript' || mime === 'text/tsx' || path.endsWith('.ts') || path.endsWith('.tsx'))
    return javascript({ typescript: true, jsx: path.endsWith('x') });
  if (mime === 'text/javascript' || mime === 'text/jsx' || path.endsWith('.js') || path.endsWith('.jsx'))
    return javascript({ jsx: path.endsWith('x') });
  if (mime === 'application/json' || path.endsWith('.json')) return json();
  if (mime === 'text/markdown' || path.endsWith('.md')) return markdown();
  if (mime === 'text/css' || path.endsWith('.css')) return css();
  if (mime === 'text/html' || path.endsWith('.html')) return html();
  return javascript({ typescript: true });
}

export function CodeViewer({
  content,
  mime,
  path,
  scrollToLine,
  editable = false,
  onSave,
  onDirtyChange,
  branch,
  worktreeId,
  baseSha256,
  restoreScrollTop,
  restoreKey,
  onScrollTopChange,
}: {
  content: string;
  mime: string;
  path: string;
  scrollToLine: number | null;
  editable?: boolean;
  onSave?: WorkspaceFileSave;
  onDirtyChange?: (dirty: boolean) => void;
  branch?: string;
  worktreeId?: string | null;
  baseSha256?: string;
  restoreScrollTop?: number | null;
  restoreKey?: string;
  onScrollTopChange?: (scrollTop: number) => void;
}) {
  const shellRef = useRef<HTMLDivElement>(null);
  const editorContainerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [selectionAction, setSelectionAction] = useState<CodeSelectionAction | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const draft = useWorkspaceFileDraft(worktreeId, path, baseSha256);
  const draftAccess = useRef(draft);
  draftAccess.current = draft;
  const visible = useWorkspaceSurfaceVisibility();
  const canEdit = editable && draft.supported && draft.ready && !draft.drifted;
  const currentThreadId = useChatStore((s) => s.currentThreadId);
  const baseContentRef = useRef(content);
  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;
  const onScrollTopChangeRef = useRef(onScrollTopChange);
  onScrollTopChangeRef.current = onScrollTopChange;

  useEffect(() => {
    if (!editorContainerRef.current) return;
    setSelectionAction(null);
    const text = editable ? (draftAccess.current.snapshot().draft?.text ?? content) : content;
    setIsDirty(text !== content);
    onDirtyChangeRef.current?.(text !== content);
    baseContentRef.current = content;
    viewRef.current?.destroy();

    const lang = getLanguageExtension(mime, path);
    const syncSelectionAction = (targetView: EditorView) =>
      setSelectionAction(selectionActionForView(targetView, shellRef.current));

    const state = EditorState.create({
      doc: text,
      extensions: [
        basicSetup,
        lang,
        cafeTheme,
        EditorView.editable.of(canEdit),
        EditorState.readOnly.of(!canEdit),
        EditorView.updateListener.of((update) => {
          if (update.selectionSet || update.geometryChanged) syncSelectionAction(update.view);
          if (update.docChanged && canEdit) {
            const current = update.state.doc.toString();
            draftAccess.current.update(current);
            const dirty = current !== baseContentRef.current;
            setIsDirty(dirty);
            onDirtyChangeRef.current?.(dirty);
          }
        }),
      ],
    });

    const view = new EditorView({ state, parent: editorContainerRef.current });
    viewRef.current = view;

    if (scrollToLine && scrollToLine > 0) {
      const line = Math.min(scrollToLine, view.state.doc.lines);
      const lineInfo = view.state.doc.line(line);
      view.dispatch({ effects: EditorView.scrollIntoView(lineInfo.from, { y: 'center' }) });
    }

    const scroller = view.scrollDOM;
    let rafId = 0;
    const handleScroll = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        onScrollTopChangeRef.current?.(scroller.scrollTop);
        syncSelectionAction(view);
      });
    };
    scroller.addEventListener('scroll', handleScroll, { passive: true });

    return () => {
      scroller.removeEventListener('scroll', handleScroll);
      if (rafId) {
        cancelAnimationFrame(rafId);
        onScrollTopChangeRef.current?.(scroller.scrollTop);
      }
      view.destroy();
    };
  }, [content, mime, path, scrollToLine, editable, canEdit, worktreeId, baseSha256, draft.generation]);

  const restoreScrollTopRef = useRef(restoreScrollTop);
  restoreScrollTopRef.current = restoreScrollTop;

  useEffect(() => {
    void restoreKey;
    const view = viewRef.current;
    if (!view || !onScrollTopChangeRef.current) return;
    const saved = restoreScrollTopRef.current;
    if (saved != null) {
      view.scrollDOM.scrollTop = saved;
    } else {
      onScrollTopChangeRef.current(view.scrollDOM.scrollTop);
    }
  }, [restoreKey]);

  const handleSave = useCallback(async () => {
    const view = viewRef.current;
    if (!view || !onSave || saving || !canEdit) return;
    const newContent = view.state.doc.toString();
    if (newContent === baseContentRef.current) return;
    setSaving(true);
    const sent = draftAccess.current.snapshot();
    try {
      const receipt = await onSave(newContent, sent.draft ? { baseSha256: sent.draft.baseSha256 } : undefined);
      if (receipt && receipt.path === path && /^[a-f0-9]{64}$/.test(receipt.sha256)) {
        draftAccess.current.saved(sent, receipt.sha256);
        if (viewRef.current === view) {
          baseContentRef.current = newContent;
          const dirty = view.state.doc.toString() !== newContent;
          setIsDirty(dirty);
          onDirtyChangeRef.current?.(dirty);
        }
      }
    } finally {
      setSaving(false);
    }
  }, [onSave, saving, canEdit, path]);

  // Cmd/Ctrl+S keyboard shortcut
  useEffect(() => {
    if (!canEdit || !onSave || !visible) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's' && shellRef.current?.contains(document.activeElement)) {
        e.preventDefault();
        handleSave();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [canEdit, onSave, handleSave, visible]);

  const handleAddToChat = useCallback(
    (comment: string) => {
      if (!selectionAction) return;
      addWorkspaceFileQuoteToChat(currentThreadId, {
        text: selectionAction.text,
        comment,
        path,
        worktreeId,
        branch,
        language: mime,
        lineStart: selectionAction.startLine,
        lineEnd: selectionAction.endLine,
        selectionStart: selectionAction.selectionStart,
        selectionEnd: selectionAction.selectionEnd,
      });
    },
    [path, branch, worktreeId, mime, currentThreadId, selectionAction],
  );

  return (
    <div ref={shellRef} className="relative flex flex-1 min-h-0 flex-col text-sm">
      <WorkspaceFileDraftNotice draft={draft} currentContent={content} saving={saving} editing={editable} />
      {editable && !draft.supported && <p role="alert">文件版本尚未核验，编辑尚未开启。</p>}
      <div className="min-h-0 flex-1 overflow-auto" ref={editorContainerRef} />
      {/* Floating action buttons — positioned over scroll area */}
      {canEdit && isDirty && (
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="absolute bottom-3 right-3 flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--semantic-success)] text-[var(--cafe-surface)] text-xs font-medium shadow-lg hover:bg-conn-green-text disabled:opacity-50 transition-colors z-10 animate-fade-in"
          title="保存 (Cmd+S)"
        >
          {saving ? '保存中...' : '保存'}
        </button>
      )}
      {/* Add to chat button (selection) */}
      {selectionAction && !editable && (
        <SelectionAnnotationAction
          selectedText={selectionAction.text}
          position={selectionAction.position}
          positionMode="absolute"
          actionTestId="workspace-code-selection-add-to-chat"
          onSave={handleAddToChat}
        />
      )}
    </div>
  );
}
