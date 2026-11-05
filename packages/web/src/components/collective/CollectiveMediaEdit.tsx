'use client';
import { useState } from 'react';
import { useReviewDraft } from '@/components/content-review/useReviewDraft';

/** Own words use the same version/Human scoped draft and the existing owner CAS operation. */
export function CollectiveMediaEdit({
  draftKey,
  body,
  reply = false,
  busy,
  onSave,
}: {
  readonly draftKey: string;
  readonly body: string;
  readonly reply?: boolean;
  readonly busy: boolean;
  readonly onSave: (body: string) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const draft = useReviewDraft(draftKey);
  return open ? (
    <form
      className="mt-2 space-y-2"
      onSubmit={async (event) => {
        event.preventDefault();
        if (await onSave(draft.draft.body)) setOpen(false);
      }}
    >
      <textarea
        aria-label={reply ? '编辑回复内容' : '编辑批注内容'}
        maxLength={8000}
        value={draft.draft.body}
        className="w-full rounded border border-cafe-subtle bg-cafe-surface p-2 text-xs"
        onChange={(event) => draft.update({ body: event.target.value, anchor: null })}
      />
      {draft.storageError && <p role="alert">输入尚未保存到浏览器，请保留页面。</p>}
      <button
        type="submit"
        className="mr-3 text-xs text-cafe-accent"
        disabled={busy || draft.storageError || !draft.draft.body.trim()}
      >
        保存修改
      </button>
      <button type="button" className="text-xs" onClick={() => setOpen(false)}>
        收起编辑
      </button>
    </form>
  ) : (
    <button
      type="button"
      aria-label={reply ? '编辑我的回复' : '编辑我的批注'}
      disabled={busy}
      className="mt-1 text-micro text-cafe-accent"
      onClick={() => {
        draft.initialize({ body, anchor: null });
        setOpen(true);
      }}
    >
      编辑
    </button>
  );
}
