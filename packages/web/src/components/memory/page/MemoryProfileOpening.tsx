import {
  type ProfileOpeningReference,
  profileOpeningReferenceSchema,
  updateProfileOpeningReference,
} from '@cat-cafe/shared/profile-opening-reference';
import { useState } from 'react';
import { formatModelName } from '@/lib/model-display-name';
import type { MemoryOwnerActionState } from './use-memory-owner-action';

export function MemoryProfileOpening({
  reference,
  content,
  revision,
  action,
}: {
  reference: ProfileOpeningReference;
  content: string;
  revision: string;
  action: MemoryOwnerActionState;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(reference);
  const [error, setError] = useState('');
  const count = [
    ...draft.excerpts
      .map((item) => item.text)
      .join('')
      .replace(/\s/g, ''),
  ].length;
  const valid = profileOpeningReferenceSchema.safeParse(draft).success;
  const save = (next: ProfileOpeningReference | null) => {
    const updated = updateProfileOpeningReference(content, next);
    if (!updated) {
      setError('暂时无法更新这段参考，原画像还在。请重读后再试。');
      return;
    }
    action.submit({ action: 'replace_content', expectedRevision: revision, content: updated });
  };
  return (
    <section aria-label="开场关系参考" className="space-y-3 rounded-lg border border-cafe-subtle p-4">
      <h4 className="text-sm font-medium">新对话开场的参考</h4>
      <p className="text-compact text-cafe-muted">参考 · 截至 {reference.asOf}</p>
      <p className="text-compact text-cafe-muted">这是选出的历史记录。能力判断只属于注明的模型，不能当作当前授权。</p>
      {editing ? (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (valid && !action.blocked) save(draft);
          }}
        >
          <label className="block text-compact">
            参考截至日期
            <input
              type="date"
              aria-label="参考截至日期"
              value={draft.asOf}
              disabled={action.busy || action.retryable}
              onChange={(event) => setDraft({ ...draft, asOf: event.target.value })}
              className="mt-1 block rounded border border-cafe-subtle bg-[var(--console-card-bg)] p-2"
            />
          </label>
          {draft.excerpts.map((item, index) => (
            <label key={`${item.source.threadId}:${item.source.messageId}:${index}`} className="block text-compact">
              {item.kind === 'relationship' ? '陪伴与关系' : `历史能力判断 · ${formatModelName(item.model)}`}
              <textarea
                aria-label={`开场参考 ${index + 1}`}
                value={item.text}
                disabled={action.busy || action.retryable}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    excerpts: draft.excerpts.map((old, at) =>
                      at === index ? { ...old, text: event.target.value } : old,
                    ),
                  })
                }
                className="mt-1 min-h-24 w-full rounded border border-cafe-subtle bg-[var(--console-card-bg)] p-2"
              />
            </label>
          ))}
          <p className="text-xs text-cafe-muted">{count} / 300 字 · 空白不计 · 原消息来源保留</p>
          {!valid && (
            <p role="alert" className="text-compact">
              请填写有效日期和参考内容，合计不超过 300 字。
            </p>
          )}
          <div className="flex flex-wrap gap-3">
            <button
              type="submit"
              disabled={!valid || action.blocked}
              className="shell-focusable text-compact text-cafe-accent underline"
            >
              保存开场参考
            </button>
            <button
              type="button"
              disabled={action.busy}
              onClick={() => setEditing(false)}
              className="shell-focusable text-compact underline"
            >
              取消修改参考
            </button>
          </div>
        </form>
      ) : (
        <>
          {reference.excerpts.map((item, index) => (
            <div key={`${item.source.threadId}:${item.source.messageId}:${index}`} className="space-y-1">
              <h5 className="text-compact font-medium">
                {item.kind === 'relationship' ? '陪伴与关系' : `历史能力判断 · ${formatModelName(item.model)}`}
              </h5>
              <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{item.text}</p>
            </div>
          ))}
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              disabled={action.blocked}
              onClick={() => {
                setDraft(reference);
                setEditing(true);
              }}
              className="shell-focusable text-compact text-cafe-accent underline"
            >
              修改开场参考
            </button>
            <button
              type="button"
              disabled={action.blocked}
              onClick={() => save(null)}
              className="shell-focusable text-compact text-cafe-accent underline"
            >
              改为按需回看
            </button>
          </div>
          <p className="text-xs text-cafe-muted">改为按需回看后，新对话开场不再带这几句，完整关系画像仍保留。</p>
        </>
      )}
      {error && (
        <p role="alert" className="text-compact">
          {error}
        </p>
      )}
    </section>
  );
}
