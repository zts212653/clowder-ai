import { useWorkspaceFileDraft } from './useWorkspaceFileDraft';

/** Alternate read-only Markdown/HTML previews mount this instead of the code editor. */
export function WorkspaceFilePreviewDraftNotice({
  worktreeId,
  path,
  sha256,
  content,
}: {
  worktreeId: string | null;
  path: string;
  sha256: string;
  content: string;
}) {
  const draft = useWorkspaceFileDraft(worktreeId, path, sha256);
  return <WorkspaceFileDraftNotice draft={draft} currentContent={content} saving={false} editing={false} />;
}

export function WorkspaceFileDraftNotice({
  draft,
  currentContent,
  saving,
  editing,
}: {
  draft: ReturnType<typeof useWorkspaceFileDraft>;
  currentContent: string;
  saving: boolean;
  editing: boolean;
}) {
  if (!draft.supported || (draft.ready && !draft.error && !draft.draft)) return null;
  return (
    <div className="shrink-0 space-y-2 border-b border-cafe-subtle px-3 py-2 text-xs">
      {!draft.ready && !draft.error && <p>正在恢复文件编辑草稿…</p>}
      {draft.error && (
        <p role="alert" className="text-cafe-error">
          {draft.error}
        </p>
      )}
      {draft.error && (
        <button type="button" onClick={draft.retry}>
          {draft.ready ? '重试保存草稿' : '重试读取草稿'}
        </button>
      )}
      {draft.draft && (
        <>
          <p>
            {draft.drifted
              ? '文件版本与草稿基准不一致，未保存的编辑已保留。请先核对当前内容与草稿。'
              : editing
                ? '正在显示未保存的编辑；原文件仍保持已保存版本。'
                : '未保存的编辑已保留；进入编辑可继续。当前正文为已保存的文件。'}
          </p>
          {!editing && !draft.drifted && (
            <details>
              <summary>查看保留的编辑</summary>
              <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words">{draft.draft.text}</pre>
            </details>
          )}
          {draft.drifted && (
            <section
              aria-label="当前文件与编辑草稿对比"
              className="grid max-h-72 grid-cols-1 gap-2 overflow-auto sm:grid-cols-2"
            >
              <div>
                <p>当前文件</p>
                <pre className="whitespace-pre-wrap break-words">{currentContent}</pre>
              </div>
              <div>
                <p>编辑草稿</p>
                <pre className="whitespace-pre-wrap break-words">{draft.draft.text}</pre>
              </div>
            </section>
          )}
          <div className="flex flex-wrap gap-3">
            {draft.drifted && (
              <button type="button" disabled={saving} onClick={draft.rebase}>
                以当前文件为基准继续这份编辑
              </button>
            )}
            <button type="button" disabled={saving} onClick={draft.clear}>
              丢弃未保存编辑
            </button>
          </div>
        </>
      )}
    </div>
  );
}
