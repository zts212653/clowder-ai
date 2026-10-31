import { ReviewCanvasToolbar } from '@/components/content-review/ReviewCanvasToolbar';
import type { useReviewMarkupDraft } from '@/components/content-review/review-markup-draft';
import styles from '@/components/content-review/review-toolbar.module.css';

type CanvasToolbarProps = Parameters<typeof ReviewCanvasToolbar>[0];
type Props = Omit<
  CanvasToolbarProps,
  'canAnnotate' | 'canEditMarkup' | 'saveAction' | 'canUndo' | 'canRedo' | 'hasMarks' | 'onUndo' | 'onRedo' | 'onClear'
> & {
  writable: boolean;
  canMarkup: boolean;
  markup: ReturnType<typeof useReviewMarkupDraft>;
  saving: boolean;
  saveDisabled: boolean;
  onSave: () => void;
};

/** Editing tools consume the canvas draft's own operations and retain the existing save receipt boundary. */
export function WorkspaceReviewMarkupToolbar({
  writable,
  canMarkup,
  markup,
  saving,
  saveDisabled,
  onSave,
  ...toolbar
}: Props) {
  const editable = writable && canMarkup && markup.canEdit;
  return (
    <ReviewCanvasToolbar
      {...toolbar}
      canAnnotate={writable}
      canEditMarkup={editable}
      canUndo={markup.canUndo && !saving}
      canRedo={markup.canRedo && !saving}
      hasMarks={markup.marks.length > 0 && !saving}
      onUndo={markup.undo}
      onRedo={markup.redo}
      onClear={markup.clear}
      saveAction={
        toolbar.mode === 'markup' ? (
          <button
            type="button"
            className={styles.saveButton}
            disabled={!editable || saveDisabled || !markup.marks.length || saving}
            onClick={onSave}
          >
            {saving ? '正在保存…' : '完成并保存'}
          </button>
        ) : null
      }
    />
  );
}
