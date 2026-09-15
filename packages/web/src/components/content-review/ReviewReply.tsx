'use client';
import type { ArtifactReviewAnnotation } from '@cat-cafe/shared';
import { useState } from 'react';
import { ReviewActor } from './ReviewActor';
import { useReviewDraft } from './useReviewDraft';

export function ReviewReply({
  reply,
  ownerUserId,
  canEdit,
  saving,
  draftKey,
  onSave,
}: {
  reply: ArtifactReviewAnnotation['replies'][number];
  ownerUserId: string;
  canEdit: boolean;
  saving: boolean;
  draftKey: string;
  onSave: (body: string) => Promise<boolean>;
}) {
  const draft = useReviewDraft(draftKey);
  const [editing, setEditing] = useState(false);
  const own = reply.author.kind === 'human' && reply.author.actorId === ownerUserId;
  return (
    <li data-reply-id={reply.id}>
      <div className="flex items-center justify-between gap-2">
        <ReviewActor actor={reply.author} ownerUserId={ownerUserId} />
        {canEdit && own ? (
          <button
            type="button"
            disabled={saving}
            className="text-xs text-cafe-accent"
            onClick={() => {
              draft.initialize({ anchor: null, body: reply.body });
              setEditing(!editing);
            }}
          >
            {editing ? '取消修改' : '修改回复'}
          </button>
        ) : null}
      </div>
      {editing && canEdit ? (
        <form
          className="mt-2 grid gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void onSave(draft.draft.body).then((ok) => {
              if (ok) {
                setEditing(false);
                draft.clear();
              }
            });
          }}
        >
          <textarea
            aria-label="修改自己的回复"
            disabled={saving}
            maxLength={8000}
            value={draft.draft.body}
            onChange={(event) => draft.update({ ...draft.draft, body: event.target.value })}
            className="min-h-16 rounded-lg border border-cafe-subtle bg-cafe-surface p-2 text-sm text-cafe-black"
          />
          <button
            type="submit"
            disabled={saving || !draft.draft.body.trim()}
            className="justify-self-end text-xs font-semibold text-cafe-accent disabled:opacity-40"
          >
            保存回复
          </button>
        </form>
      ) : (
        <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6 text-cafe-secondary">{reply.body}</p>
      )}
      {draft.storageError ? (
        <p role="alert" className="mt-2 text-xs text-cafe-error">
          修改尚未保存到浏览器，请保留当前页面。
        </p>
      ) : null}
    </li>
  );
}
