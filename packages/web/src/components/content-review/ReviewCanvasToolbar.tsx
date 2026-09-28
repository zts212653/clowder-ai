'use client';
import type { ReactNode } from 'react';
import { ReviewToolbarIcon } from './ReviewToolbarIcon';
import { ReviewColorMenu, ReviewShapeMenu } from './ReviewToolOptions';
import type { MARKUP_COLORS, MARKUP_STROKE_WIDTHS, ReviewMarkupTool } from './review-markup-draft';
import styles from './review-toolbar.module.css';

export type ReviewCanvasMode = 'view' | 'markup' | 'comment';

const modeLabels: Record<ReviewCanvasMode, string> = { view: '查看', markup: '标注', comment: '评论' };
const toolLabels: Record<ReviewMarkupTool, string> = {
  select: '选择',
  brush: '画笔',
  rectangle: '矩形',
  ellipse: '椭圆',
  arrow: '箭头',
  text: '文字',
  eraser: '删除',
};

export function ReviewCanvasToolbar({
  mode,
  canAnnotate,
  canEditMarkup,
  onModeChange,
  tool,
  onToolChange,
  color,
  onColorChange,
  strokeWidth,
  onStrokeWidthChange,
  text,
  onTextChange,
  canUndo,
  canRedo,
  hasMarks,
  onUndo,
  onRedo,
  onClear,
  composer,
  imageMenu,
}: {
  mode: ReviewCanvasMode;
  canAnnotate: boolean;
  canEditMarkup: boolean;
  onModeChange: (mode: ReviewCanvasMode) => void;
  tool: ReviewMarkupTool;
  onToolChange: (tool: ReviewMarkupTool) => void;
  color: (typeof MARKUP_COLORS)[number];
  onColorChange: (color: (typeof MARKUP_COLORS)[number]) => void;
  strokeWidth: (typeof MARKUP_STROKE_WIDTHS)[number];
  onStrokeWidthChange: (width: (typeof MARKUP_STROKE_WIDTHS)[number]) => void;
  text: string;
  onTextChange: (text: string) => void;
  canUndo: boolean;
  canRedo: boolean;
  hasMarks: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onClear: () => void;
  composer?: ReactNode;
  imageMenu?: ReactNode;
}) {
  return (
    <section className={styles.toolbar} aria-label="作品画布工具" data-review-mode={mode}>
      {mode === 'view' ? (
        <div className={styles.dock} role="toolbar" aria-label="作品操作模式">
          {(['markup', 'comment'] as const).map((candidate) => (
            <button
              key={candidate}
              type="button"
              disabled={!canAnnotate}
              className={styles.modeButton}
              data-mode={candidate}
              onClick={() => onModeChange(candidate)}
            >
              <ReviewToolbarIcon name={candidate} />
              {modeLabels[candidate]}
            </button>
          ))}
          {imageMenu}
        </div>
      ) : null}
      {mode === 'markup' ? (
        <div className={`${styles.dock} ${styles.toolbox}`}>
          {(['select', 'brush', 'text'] as const).map((candidate) => (
            <button
              key={candidate}
              type="button"
              aria-pressed={tool === candidate}
              className={styles.iconButton}
              aria-label={toolLabels[candidate]}
              title={toolLabels[candidate]}
              disabled={!canEditMarkup}
              onClick={() => onToolChange(candidate)}
            >
              <ReviewToolbarIcon name={candidate} />
            </button>
          ))}
          <ReviewShapeMenu tool={tool} onToolChange={onToolChange} disabled={!canEditMarkup} />
          <ReviewColorMenu
            color={color}
            strokeWidth={strokeWidth}
            onColorChange={onColorChange}
            onStrokeWidthChange={onStrokeWidthChange}
            disabled={!canEditMarkup}
          />
          <button
            type="button"
            className={styles.iconButton}
            aria-label="删除"
            title="删除标记"
            aria-pressed={tool === 'eraser'}
            disabled={!canEditMarkup}
            onClick={() => onToolChange('eraser')}
          >
            <ReviewToolbarIcon name="eraser" />
          </button>
          <span className={styles.separator} aria-hidden />
          <button
            type="button"
            className={styles.iconButton}
            aria-label="撤销"
            title="撤销"
            disabled={!canEditMarkup || !canUndo}
            onClick={onUndo}
          >
            <ReviewToolbarIcon name="undo" />
          </button>
          <button
            type="button"
            className={styles.iconButton}
            aria-label="重做"
            title="重做"
            disabled={!canEditMarkup || !canRedo}
            onClick={onRedo}
          >
            <ReviewToolbarIcon name="redo" />
          </button>
          <details className={styles.toolMenu}>
            <summary className={styles.iconButton} aria-label="标注更多操作" title="更多">
              <ReviewToolbarIcon name="more" />
            </summary>
            <div className={styles.menu}>
              <button
                type="button"
                className={styles.menuChoice}
                disabled={!canEditMarkup || !hasMarks}
                onClick={onClear}
              >
                清空草稿
              </button>
            </div>
          </details>
          <button
            type="button"
            className={styles.iconButton}
            aria-label="退出标注"
            title="退出标注"
            onClick={() => onModeChange('view')}
          >
            <ReviewToolbarIcon name="close" />
          </button>
        </div>
      ) : null}
      {mode === 'markup' && tool === 'text' ? (
        <label className={styles.textTool}>
          <ReviewToolbarIcon name="text" />
          <input
            aria-label="标注文字"
            value={text}
            disabled={!canEditMarkup}
            maxLength={240}
            onChange={(event) => onTextChange(event.target.value)}
            placeholder="输入文字，再点在画面上"
          />
        </label>
      ) : null}
      {mode === 'comment'
        ? (composer ?? (
            <div className={styles.dock}>
              <span className="px-3 text-xs text-cafe-muted">点击或圈选画面，添加评论</span>
              <button
                type="button"
                className={styles.iconButton}
                aria-label="退出评论"
                onClick={() => onModeChange('view')}
              >
                <ReviewToolbarIcon name="close" />
              </button>
            </div>
          ))
        : null}
    </section>
  );
}
