'use client';
import type { ImmutableMedia } from '@cat-cafe/shared';
import type { RefObject } from 'react';
import type { ReviewCanvasMode } from './ReviewCanvasToolbar';
import { ReviewToolbarIcon } from './ReviewToolbarIcon';
import styles from './review-comment.module.css';
import { anchorLabel } from './review-geometry';
import toolbar from './review-toolbar.module.css';
import type { ReviewDraft } from './useReviewDraft';

type ComposerDraft = {
  draft: ReviewDraft;
  hasDraft: boolean;
  storageError: boolean;
  update: (next: ReviewDraft) => void;
  clear: () => void;
};

export function ReviewCommentComposer({
  mode,
  media,
  draft,
  saving,
  textareaRef,
  onSave,
  onClose,
}: {
  mode: Exclude<ReviewCanvasMode, 'markup'>;
  media: ImmutableMedia;
  draft: ComposerDraft;
  saving: boolean;
  textareaRef: RefObject<HTMLTextAreaElement>;
  onSave: () => void;
  onClose?: () => void;
}) {
  const commentMode = mode === 'comment';
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
      className={styles.composer}
    >
      {!draft.draft.anchor ? <ReviewToolbarIcon name="comment" /> : null}
      <label>
        <span className="sr-only">
          {draft.draft.reanchoredFrom
            ? '请在新版重新圈选位置'
            : commentMode
              ? '这处想和猫讨论什么？'
              : '这处需要怎样调整？'}
        </span>
        <textarea
          ref={textareaRef}
          aria-label="新增标注意见"
          disabled={saving}
          maxLength={8000}
          value={draft.draft.body}
          onChange={(event) => draft.update({ ...draft.draft, body: event.target.value })}
          rows={1}
          placeholder={draft.draft.anchor ? '写下这处想调整的地方…' : '点击或圈选画面，留下评论…'}
        />
      </label>
      <div className={styles.composerCaption}>
        <span title={draft.draft.anchor ? anchorLabel(draft.draft.anchor, media) : undefined}>
          {draft.draft.anchor ? '已选好位置' : '在画面上点击或圈出要讨论的位置'}
        </span>
        {draft.hasDraft ? (
          <button
            type="button"
            disabled={saving}
            className="ml-2 text-cafe-muted underline disabled:opacity-40"
            onClick={draft.clear}
          >
            清空草稿
          </button>
        ) : null}
      </div>
      <button
        type="submit"
        aria-label={commentMode ? '保存评论' : '保存标注'}
        title="发送评论"
        disabled={saving || !draft.draft.anchor || !draft.draft.body.trim()}
        className={styles.send}
      >
        <ReviewToolbarIcon name="send" />
      </button>
      {onClose && !draft.draft.anchor ? (
        <button type="button" className={toolbar.iconButton} aria-label="退出评论" title="退出评论" onClick={onClose}>
          <ReviewToolbarIcon name="close" />
        </button>
      ) : null}
      {draft.storageError ? (
        <p role="alert" className="mt-2 text-xs text-cafe-error">
          草稿暂未保存到浏览器，请保留页面。
        </p>
      ) : null}
    </form>
  );
}
