import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { basicSetup, EditorView } from 'codemirror';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';

const cafeTheme = EditorView.theme(
  {
    '&': { backgroundColor: '#1E1E24', color: '#FDF8F3' },
    '.cm-gutters': { backgroundColor: '#1E1E24', color: '#815B5B', borderRight: '1px solid #2a2a32' },
    '.cm-activeLineGutter': { backgroundColor: '#2a2a32' },
    '.cm-activeLine': { backgroundColor: 'rgba(155, 126, 189, 0.08)' },
    '.cm-cursor': { borderLeftColor: '#E29578' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
      backgroundColor: 'rgba(155, 126, 189, 0.25) !important',
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
  return { text, startLine, endLine };
}

const AddToChatIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <path d="M1.5 2.5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v5.5a1 1 0 0 1-1 1H5L2.5 11.5V9h-1a1 1 0 0 1-1-1V2.5Z" />
    <path d="M13.5 5v4a1 1 0 0 1-1 1H12v2.5L9.5 10H7a1 1 0 0 1-1-1" opacity="0.5" />
  </svg>
);

export function CodeViewer({
  content,
  mime,
  path,
  scrollToLine,
  editable = false,
  onSave,
  branch,
}: {
  content: string;
  mime: string;
  path: string;
  scrollToLine: number | null;
  editable?: boolean;
  onSave?: (newContent: string) => Promise<void>;
  branch?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [hasSelection, setHasSelection] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const setPendingChatInsert = useChatStore((s) => s.setPendingChatInsert);
  const currentThreadId = useChatStore((s) => s.currentThreadId);
  const baseContentRef = useRef(content);

  useEffect(() => {
    if (!containerRef.current) return;
    setHasSelection(false);
    setIsDirty(false);
    baseContentRef.current = content;
    viewRef.current?.destroy();

    const lang = getLanguageExtension(mime, path);
    const state = EditorState.create({
      doc: content,
      extensions: [
        basicSetup,
        lang,
        cafeTheme,
        EditorView.editable.of(editable),
        EditorState.readOnly.of(!editable),
        EditorView.updateListener.of((update) => {
          if (update.selectionSet) {
            const sel = getSelectionInfo(update.view);
            setHasSelection(!!sel);
          }
          if (update.docChanged && editable) {
            const current = update.state.doc.toString();
            setIsDirty(current !== baseContentRef.current);
          }
        }),
      ],
    });

    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;

    if (scrollToLine && scrollToLine > 0) {
      const line = Math.min(scrollToLine, view.state.doc.lines);
      const lineInfo = view.state.doc.line(line);
      view.dispatch({ effects: EditorView.scrollIntoView(lineInfo.from, { y: 'center' }) });
    }

    return () => {
      view.destroy();
    };
  }, [content, mime, path, scrollToLine, editable]);

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

  const handleAddToChat = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    const sel = getSelectionInfo(view);
    if (!sel) return;
    const lineRange = sel.startLine === sel.endLine ? `${sel.startLine}` : `${sel.startLine}-${sel.endLine}`;
    const suffix = branch ? ` (🌿 ${branch})` : '';
    const ref = `\`${path}:${lineRange}\`${suffix}\n\`\`\`\n${sel.text}\n\`\`\``;
    setPendingChatInsert({ threadId: currentThreadId, text: ref });
  }, [path, branch, setPendingChatInsert, currentThreadId]);

  return (
    <div className="relative flex-1 min-h-0 text-sm">
      <div className="h-full overflow-auto" ref={containerRef} />
      {/* Floating action buttons — positioned over scroll area */}
      {editable && isDirty && (
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="absolute bottom-3 right-3 flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-green-600 text-white text-[11px] font-medium shadow-lg hover:bg-green-500 disabled:opacity-50 transition-colors z-10 animate-fade-in"
          title="保存 (Cmd+S)"
        >
          {saving ? '保存中...' : '保存'}
        </button>
      )}
      {/* Add to chat button (selection) */}
      {hasSelection && !editable && (
        <button
          type="button"
          onClick={handleAddToChat}
          className="absolute top-2 right-3 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-cocreator-primary text-white text-[11px] font-medium shadow-lg hover:bg-cocreator-dark transition-colors z-10 animate-fade-in"
          title="引用到聊天"
        >
          <AddToChatIcon />
          Add to chat
        </button>
      )}
    </div>
  );
}
