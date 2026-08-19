import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { basicSetup, EditorView } from 'codemirror';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { createQuoteContextAttachment } from '../chat-context-reference';
import { SelectionAnnotationAction } from '../SelectionAnnotationAction';
import {
  type FloatingSelectionPosition,
  positionSelectionActionForAnchors,
  type RectLike,
  selectionAnchorPositionsForRows,
  selectionOffsetInRange,
} from './selection-action-position';

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

function getSelectionInfo(view: EditorView) {
  const { from, to } = view.state.selection.main;
  if (from === to) return null;
  const text = view.state.sliceDoc(from, to);
  if (!text.trim()) return null;
  const startLine = view.state.doc.lineAt(from).number;
  const endLine = view.state.doc.lineAt(to).number;
  return { text, startLine, endLine, selectionStart: from, selectionEnd: to };
}

interface CodeSelectionAction {
  position: FloatingSelectionPosition;
  text: string;
  startLine: number;
  endLine: number;
  selectionStart: number;
  selectionEnd: number;
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
  restoreScrollTop,
  restoreKey,
  onScrollTopChange,
}: {
  content: string;
  mime: string;
  path: string;
  scrollToLine: number | null;
  editable?: boolean;
  onSave?: (newContent: string) => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
  branch?: string;
  worktreeId?: string | null;
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
  const setPendingChatInsert = useChatStore((s) => s.setPendingChatInsert);
  const currentThreadId = useChatStore((s) => s.currentThreadId);
  const baseContentRef = useRef(content);
  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;
  const onScrollTopChangeRef = useRef(onScrollTopChange);
  onScrollTopChangeRef.current = onScrollTopChange;

  useEffect(() => {
    if (!editorContainerRef.current) return;
    setSelectionAction(null);
    setIsDirty(false);
    onDirtyChangeRef.current?.(false);
    baseContentRef.current = content;
    viewRef.current?.destroy();

    const lang = getLanguageExtension(mime, path);
    const syncSelectionAction = (targetView: EditorView) => {
      const shell = shellRef.current;
      const selection = getSelectionInfo(targetView);
      if (!shell || !selection) {
        setSelectionAction(null);
        return;
      }
      const shellRect = shell.getBoundingClientRect();
      const mainSelection = targetView.state.selection.main;
      const offsets = selectionAnchorPositionsForRows(mainSelection, targetView.viewportLineBlocks);
      const editorRect = targetView.dom.getBoundingClientRect();
      const anchorOffsets = new Set<number>();
      const anchors: RectLike[] = [];
      const addAnchor = (offset: number) => {
        if (anchorOffsets.has(offset)) return null;
        anchorOffsets.add(offset);
        const coords = targetView.coordsAtPos(offset);
        if (!coords) return null;
        anchors.push({
          ...coords,
          width: coords.right - coords.left,
          height: coords.bottom - coords.top,
        });
        return coords;
      };

      for (const offset of offsets) {
        const coords = addAnchor(offset);
        if (!coords) continue;
        const visibleTop = Math.max(coords.top, editorRect.top);
        const visibleBottom = Math.min(coords.bottom, editorRect.bottom);
        if (visibleTop >= visibleBottom) continue;
        const y = (visibleTop + visibleBottom) / 2;
        const left = targetView.posAtCoords({ x: editorRect.left + 1, y });
        const right = targetView.posAtCoords({ x: editorRect.right - 1, y });
        if (left === null || right === null) continue;
        const visibleOffset = selectionOffsetInRange(mainSelection, {
          from: Math.min(left, right),
          to: Math.max(left, right),
        });
        if (visibleOffset !== null) addAnchor(visibleOffset);
      }
      const position = positionSelectionActionForAnchors(anchors, shellRect);
      setSelectionAction(position ? { position, ...selection } : null);
    };

    const state = EditorState.create({
      doc: content,
      extensions: [
        basicSetup,
        lang,
        cafeTheme,
        EditorView.editable.of(editable),
        EditorState.readOnly.of(!editable),
        EditorView.updateListener.of((update) => {
          if (update.selectionSet || update.geometryChanged) syncSelectionAction(update.view);
          if (update.docChanged && editable) {
            const current = update.state.doc.toString();
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
  }, [content, mime, path, scrollToLine, editable]);

  const restoreScrollTopRef = useRef(restoreScrollTop);
  restoreScrollTopRef.current = restoreScrollTop;

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !onScrollTopChangeRef.current) return;
    const saved = restoreScrollTopRef.current;
    if (saved != null) {
      view.scrollDOM.scrollTop = saved;
    } else {
      onScrollTopChangeRef.current(view.scrollDOM.scrollTop);
    }
  }, [restoreKey, onScrollTopChange]);

  const handleSave = useCallback(async () => {
    const view = viewRef.current;
    if (!view || !onSave || saving) return;
    const newContent = view.state.doc.toString();
    if (newContent === baseContentRef.current) return;
    setSaving(true);
    try {
      await onSave(newContent);
    } finally {
      setSaving(false);
    }
  }, [onSave, saving]);

  // Cmd/Ctrl+S keyboard shortcut
  useEffect(() => {
    if (!editable || !onSave) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [editable, onSave, handleSave]);

  const handleAddToChat = useCallback(
    (comment: string) => {
      if (!selectionAction) return;
      setPendingChatInsert({
        threadId: currentThreadId,
        text: '',
        contextAttachments: [
          createQuoteContextAttachment(
            selectionAction.text,
            {
              kind: 'workspace_file',
              path,
              ...(worktreeId ? { worktreeId } : {}),
              ...(branch ? { branch } : {}),
              ...(mime ? { language: mime } : {}),
              lineStart: selectionAction.startLine,
              lineEnd: selectionAction.endLine,
            },
            {
              comment,
              selectionStart: selectionAction.selectionStart,
              selectionEnd: selectionAction.selectionEnd,
            },
          ),
        ],
      });
    },
    [path, branch, worktreeId, mime, setPendingChatInsert, currentThreadId, selectionAction],
  );

  return (
    <div ref={shellRef} className="relative flex-1 min-h-0 text-sm">
      <div className="h-full overflow-auto" ref={editorContainerRef} />
      {/* Floating action buttons — positioned over scroll area */}
      {editable && isDirty && (
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
