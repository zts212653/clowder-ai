import {
  type CollectiveComposerRichEditor,
  collectiveComposerDraftSchema,
  collectiveMessageRichBlockSchema,
} from '@cat-cafe/shared';
import { type Dispatch, type SetStateAction, useState } from 'react';
import { useCollectiveLanguage } from './collective-copy.js';
import type { ComposerDraft } from './composer-draft.js';

export function ComposerRichContent({
  draft,
  setDraft,
  expanded,
}: {
  draft: ComposerDraft;
  setDraft: Dispatch<SetStateAction<ComposerDraft>>;
  expanded: boolean;
}) {
  const en = useCollectiveLanguage() === 'en';
  const [notice, setNotice] = useState<string>();
  const editor = draft.richEditor;
  const labels = {
    checklist: en ? 'Checklist' : '清单',
    interactive: en ? 'Reply choices' : '回复选项',
    html_widget: en ? 'HTML content' : 'HTML 交互',
    diff: 'Diff',
  };
  const edit = (patch: Partial<CollectiveComposerRichEditor>) =>
    setDraft((current) =>
      current.richEditor ? { ...current, richEditor: { ...current.richEditor, ...patch } } : current,
    );
  const add = () => {
    if (!editor || !editor.source.trim()) return;
    const lines = editor.source
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const base = { v: 1, id: `rich_${crypto.randomUUID()}`, kind: editor.kind };
    const value =
      editor.kind === 'checklist'
        ? {
            ...base,
            title: editor.title || undefined,
            items: lines.map((text, index) => ({ id: `item-${index}`, text })),
          }
        : editor.kind === 'interactive'
          ? {
              ...base,
              title: editor.title || undefined,
              interactiveType: 'select',
              options: lines.map((label, index) => ({ id: `choice-${index}`, label })),
            }
          : editor.kind === 'diff'
            ? { ...base, filePath: editor.title || 'Diff', diff: editor.source }
            : { ...base, title: editor.title || undefined, html: editor.source };
    const block = collectiveMessageRichBlockSchema.safeParse(value);
    const next =
      block.success &&
      collectiveComposerDraftSchema.safeParse({
        ...draft,
        richEditor: undefined,
        richBlocks: [...(draft.richBlocks ?? []), block.data],
      });
    if (!next || !next.success) {
      setNotice(
        en
          ? 'This content is too large or incomplete; it is still in your private draft.'
          : '内容太长或还没填好，仍保留在私人草稿里。',
      );
      return;
    }
    setDraft(next.data);
    setNotice(undefined);
  };
  return (
    <>
      {draft.richBlocks?.map((block) => (
        <div key={block.id} className="composer-rich-preview">
          <strong>
            {block.kind === 'file'
              ? block.fileName
              : block.kind === 'diff'
                ? block.filePath
                : ('title' in block && block.title) || block.kind}
          </strong>
          <span>
            {block.kind === 'checklist'
              ? block.items.map((item) => item.text).join(' · ')
              : block.kind === 'interactive'
                ? block.options.map((option) => option.label).join(' · ')
                : block.kind === 'html_widget'
                  ? en
                    ? 'Interactive HTML'
                    : 'HTML 交互内容'
                  : ''}
          </span>
          <button
            type="button"
            aria-label={en ? 'Remove content' : '移除内容'}
            onClick={() =>
              setDraft((current) => ({
                ...current,
                richBlocks: current.richBlocks?.filter((item) => item.id !== block.id),
              }))
            }
          >
            ×
          </button>
        </div>
      ))}
      {expanded && !editor && (
        <div className="composer-rich-tools">
          {(Object.keys(labels) as (keyof typeof labels)[]).map((kind) => (
            <button
              key={kind}
              type="button"
              disabled={(draft.richBlocks?.length ?? 0) >= 12}
              onClick={() => setDraft((current) => ({ ...current, richEditor: { kind, source: '', title: '' } }))}
            >
              {labels[kind]}
            </button>
          ))}
        </div>
      )}
      {editor && (
        <fieldset className="composer-rich-editor">
          <legend>{labels[editor.kind]}</legend>
          <label>
            {editor.kind === 'diff' ? (en ? 'File name' : '文件名') : en ? 'Title (optional)' : '标题（可选）'}
            <input value={editor.title} maxLength={240} onChange={(event) => edit({ title: event.target.value })} />
          </label>
          <label>
            {editor.kind === 'checklist' || editor.kind === 'interactive'
              ? en
                ? 'One item per line'
                : '每行一项'
              : labels[editor.kind]}
            <textarea
              value={editor.source}
              maxLength={48_000}
              rows={5}
              onChange={(event) => edit({ source: event.target.value })}
            />
          </label>
          {editor.kind === 'interactive' && (
            <small>{en ? 'Choices go into each member’s reply draft.' : '成员选择后放进自己的回复草稿。'}</small>
          )}
          {(editor.kind === 'html_widget' || editor.kind === 'diff') && (
            <label>
              {en ? 'Choose a file' : '选择文件'}
              <input
                type="file"
                accept={editor.kind === 'html_widget' ? '.html,.htm' : '.diff,.patch'}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  if (file.size > 192 * 1024) {
                    setNotice(en ? 'Send this larger content as a file instead.' : '内容较长，请改为普通文件发送。');
                    return;
                  }
                  const currentEditor = editor;
                  void file
                    .text()
                    .then((source) => {
                      if (source.length > 48_000) {
                        setNotice(
                          en ? 'Send this larger content as a file instead.' : '内容较长，请改为普通文件发送。',
                        );
                        return;
                      }
                      setDraft((current) =>
                        current.richEditor === currentEditor
                          ? {
                              ...current,
                              richEditor: { ...currentEditor, source, title: currentEditor.title || file.name },
                            }
                          : current,
                      );
                    })
                    .catch(() => setNotice(en ? 'Could not read this file' : '暂时无法读取这份文件'));
                  event.target.value = '';
                }}
              />
            </label>
          )}
          <button type="button" onClick={add} disabled={!editor.source.trim()}>
            {en ? 'Add to draft' : '放进草稿'}
          </button>
          <button type="button" onClick={() => setDraft((current) => ({ ...current, richEditor: undefined }))}>
            {en ? 'Cancel' : '取消'}
          </button>
        </fieldset>
      )}
      {notice && <p role="status">{notice}</p>}
    </>
  );
}
