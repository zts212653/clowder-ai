import { ReviewToolbarIcon } from './ReviewToolbarIcon';
import { MARKUP_COLORS, MARKUP_STROKE_WIDTHS, type ReviewMarkupTool } from './review-markup-draft';
import styles from './review-toolbar.module.css';

const shapes = { rectangle: '矩形', ellipse: '椭圆', arrow: '箭头' } as const;
function closeMenu(button: HTMLButtonElement) {
  const details = button.closest('details');
  if (details) details.open = false;
}

export function ReviewShapeMenu({
  tool,
  onToolChange,
  disabled,
}: {
  tool: ReviewMarkupTool;
  onToolChange: (tool: ReviewMarkupTool) => void;
  disabled: boolean;
}) {
  const selected = tool === 'ellipse' || tool === 'arrow' ? tool : 'rectangle';
  return (
    <details className={styles.toolMenu}>
      <summary
        className={styles.iconButton}
        aria-label="形状"
        aria-pressed={tool === 'rectangle' || tool === 'ellipse' || tool === 'arrow'}
        role="button"
        title="形状"
        aria-disabled={disabled}
        onClick={(event) => {
          if (disabled) event.preventDefault();
        }}
      >
        <ReviewToolbarIcon name={selected} />
      </summary>
      <div className={styles.menu}>
        <p className={styles.menuLabel}>用形状指出位置</p>
        {(Object.keys(shapes) as (keyof typeof shapes)[]).map((shape) => (
          <button
            key={shape}
            type="button"
            className={styles.menuChoice}
            aria-pressed={tool === shape}
            disabled={disabled}
            onClick={(event) => {
              onToolChange(shape);
              closeMenu(event.currentTarget);
            }}
          >
            <ReviewToolbarIcon name={shape} />
            {shapes[shape]}
          </button>
        ))}
      </div>
    </details>
  );
}

export function ReviewColorMenu({
  color,
  strokeWidth,
  onColorChange,
  onStrokeWidthChange,
  disabled,
}: {
  color: (typeof MARKUP_COLORS)[number];
  strokeWidth: (typeof MARKUP_STROKE_WIDTHS)[number];
  onColorChange: (color: (typeof MARKUP_COLORS)[number]) => void;
  onStrokeWidthChange: (width: (typeof MARKUP_STROKE_WIDTHS)[number]) => void;
  disabled: boolean;
}) {
  return (
    <details className={styles.toolMenu}>
      <summary
        className={styles.iconButton}
        aria-label="颜色与线条"
        role="button"
        title="颜色与线条"
        aria-disabled={disabled}
        onClick={(event) => {
          if (disabled) event.preventDefault();
        }}
      >
        <span className={styles.colorDot} style={{ backgroundColor: color }} />
      </summary>
      <div className={styles.menu}>
        <fieldset className="m-0 border-0 p-0">
          <legend className={styles.menuLabel}>标注颜色</legend>
          <div className={styles.menuRow}>
            {MARKUP_COLORS.map((candidate) => (
              <button
                key={candidate}
                type="button"
                aria-label={`选择颜色 ${candidate}`}
                aria-pressed={candidate === color}
                disabled={disabled}
                className={styles.swatch}
                onClick={(event) => {
                  onColorChange(candidate);
                  closeMenu(event.currentTarget);
                }}
              >
                <span className={styles.colorDot} style={{ backgroundColor: candidate }} />
              </button>
            ))}
          </div>
        </fieldset>
        <fieldset className="mb-0 mt-4 border-0 p-0">
          <legend className={styles.menuLabel}>线条粗细</legend>
          <div className={styles.menuRow}>
            {MARKUP_STROKE_WIDTHS.map((candidate) => (
              <button
                key={candidate}
                type="button"
                aria-label={`线条粗细 ${candidate}`}
                title={`${candidate}px`}
                aria-pressed={candidate === strokeWidth}
                disabled={disabled}
                className={styles.iconButton}
                onClick={(event) => {
                  onStrokeWidthChange(candidate);
                  closeMenu(event.currentTarget);
                }}
              >
                <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
                  <path d="M5 12h14" stroke="currentColor" strokeWidth={candidate} strokeLinecap="round" />
                </svg>
              </button>
            ))}
          </div>
        </fieldset>
      </div>
    </details>
  );
}
