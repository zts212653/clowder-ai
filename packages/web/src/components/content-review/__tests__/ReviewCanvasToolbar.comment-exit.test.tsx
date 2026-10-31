import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { type ReviewCanvasMode, ReviewCanvasToolbar } from '../ReviewCanvasToolbar';
import { MARKUP_COLORS, MARKUP_STROKE_WIDTHS } from '../review-markup-draft';

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function renderComment(composer: React.ReactNode, onModeChange: (mode: ReviewCanvasMode) => void) {
  await act(async () =>
    root.render(
      createElement(ReviewCanvasToolbar, {
        mode: 'comment',
        canAnnotate: true,
        canEditMarkup: true,
        onModeChange,
        tool: 'select',
        onToolChange: vi.fn(),
        color: MARKUP_COLORS[0],
        onColorChange: vi.fn(),
        strokeWidth: MARKUP_STROKE_WIDTHS[0],
        onStrokeWidthChange: vi.fn(),
        canUndo: false,
        canRedo: false,
        hasMarks: false,
        onUndo: vi.fn(),
        onRedo: vi.fn(),
        onClear: vi.fn(),
        composer,
      }),
    ),
  );
}

it.each([
  ['the built-in hint', null],
  ['a host composer', createElement('form', { 'aria-label': 'host composer' })],
])('comment mode with %s can always be left', async (_name, composer) => {
  const onModeChange = vi.fn();
  await renderComment(composer, onModeChange);
  if (composer) expect(container.querySelector('form[aria-label="host composer"]')).not.toBeNull();
  const exit = container.querySelector<HTMLButtonElement>('button[aria-label="退出评论"]');
  expect(exit).not.toBeNull();
  await act(async () => exit!.click());
  expect(onModeChange).toHaveBeenCalledWith('view');
});
