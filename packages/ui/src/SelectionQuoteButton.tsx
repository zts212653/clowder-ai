import { createPortal } from 'react-dom';
import type { FloatingSelectionPosition } from './selection-action-position';

export function SelectionQuoteButton({
  position,
  label,
  onQuote,
}: {
  readonly position: FloatingSelectionPosition;
  readonly label: string;
  readonly onQuote: () => void;
}) {
  return createPortal(
    <button
      type="button"
      className="cafe-selection-quote"
      data-quote-exclude=""
      style={{ top: position.top, left: position.left }}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onQuote}
    >
      {label}
    </button>,
    document.body,
  );
}
