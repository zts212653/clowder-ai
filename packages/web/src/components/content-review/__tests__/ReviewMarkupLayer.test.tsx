import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ReviewMarkupLayer } from '../ReviewMarkupLayer';

let root: ReturnType<typeof createRoot>, container: HTMLDivElement;
const onAdd = vi.fn();

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  onAdd.mockClear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});
async function render({
  drawingKey = 'markup:one',
  canAdd = true,
  tool = 'rectangle',
  text = '',
}: {
  drawingKey?: string;
  canAdd?: boolean;
  tool?: 'rectangle' | 'text';
  text?: string;
} = {}) {
  await act(async () =>
    root.render(
      createElement(ReviewMarkupLayer, {
        media: { width: 100, height: 60 },
        marks: [],
        selectedId: null,
        canAdd,
        tool,
        color: '#d04a3a',
        strokeWidth: 4,
        text,
        drawingKey,
        onAdd,
        onSelect: vi.fn(),
        onRemove: vi.fn(),
        onTextRequired: vi.fn(),
        onNotice: vi.fn(),
        onDrawStart: vi.fn(),
      }),
    ),
  );
}
function pointer(type: string, pointerId: number, clientX: number, clientY: number) {
  const result = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(result, {
    pointerId: { value: pointerId },
    clientX: { value: clientX },
    clientY: { value: clientY },
  });
  return result;
}
function surface() {
  const layer = container.querySelector<SVGSVGElement>('[data-testid="review-markup-layer"]')!;
  Object.defineProperty(layer, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ left: 0, top: 0, width: 100, height: 60 }),
  });
  const captures = new Set<number>();
  Object.defineProperties(layer, {
    setPointerCapture: { configurable: true, value: (pointerId: number) => captures.add(pointerId) },
    hasPointerCapture: { configurable: true, value: (pointerId: number) => captures.has(pointerId) },
    releasePointerCapture: { configurable: true, value: (pointerId: number) => captures.delete(pointerId) },
  });
  return { layer, captures };
}

it('text authoring preserves a numeric media-space size independently of live UI typography overrides', async () => {
  container.style.setProperty('--console-font-lg', '32px');
  await render({ tool: 'text', text: '保留暖光' });
  const { layer } = surface();
  await act(async () => layer.dispatchEvent(pointer('pointerdown', 1, 20, 30)));
  expect(onAdd).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: 'text',
      at: { x: 20, y: 30 },
      text: '保留暖光',
      fontSize: 18,
    }),
  );
});

it('fences markup gestures by pointer, draft identity, capability, and cancellation', async () => {
  await render();
  const { layer, captures } = surface();
  await act(async () => layer.dispatchEvent(pointer('pointerdown', 1, 10, 10)));
  await act(async () => layer.dispatchEvent(pointer('pointermove', 1, 30, 30)));
  await act(async () => layer.dispatchEvent(pointer('pointerdown', 2, 20, 20)));
  await act(async () => layer.dispatchEvent(pointer('pointermove', 2, 40, 40)));
  await act(async () => layer.dispatchEvent(pointer('pointerup', 2, 40, 40)));
  expect(onAdd).not.toHaveBeenCalled();
  await act(async () => layer.dispatchEvent(pointer('pointerup', 1, 30, 30)));
  expect(onAdd).toHaveBeenCalledTimes(1);

  onAdd.mockClear();
  await act(async () => layer.dispatchEvent(pointer('pointerdown', 3, 10, 10)));
  await render({ drawingKey: 'markup:exit-view' });
  expect(captures.has(3)).toBe(false);
  await act(async () => layer.dispatchEvent(pointer('pointerup', 3, 30, 30)));
  expect(onAdd).not.toHaveBeenCalled();

  await render();
  await act(async () => layer.dispatchEvent(pointer('pointerdown', 4, 10, 10)));
  await render({ drawingKey: 'markup:exit-comment' });
  await act(async () => layer.dispatchEvent(pointer('pointerup', 4, 30, 30)));
  expect(onAdd).not.toHaveBeenCalled();

  await render();
  await act(async () => layer.dispatchEvent(pointer('pointerdown', 5, 10, 10)));
  await render({ canAdd: false });
  await act(async () => layer.dispatchEvent(pointer('pointerup', 5, 30, 30)));
  expect(onAdd).not.toHaveBeenCalled();

  await render();
  await act(async () => layer.dispatchEvent(pointer('pointerdown', 6, 10, 10)));
  await act(async () => layer.dispatchEvent(pointer('pointercancel', 6, 30, 30)));
  await act(async () => layer.dispatchEvent(pointer('pointerup', 6, 30, 30)));
  expect(onAdd).not.toHaveBeenCalled();

  await render();
  await act(async () => layer.dispatchEvent(pointer('pointerdown', 7, 10, 10)));
  await act(async () => layer.dispatchEvent(pointer('pointercancel', 5, 30, 30)));
  await act(async () => layer.dispatchEvent(pointer('pointerup', 7, 30, 30)));
  expect(onAdd).toHaveBeenCalledTimes(1);
  onAdd.mockClear();
  await act(async () => layer.dispatchEvent(pointer('pointercancel', 7, 30, 30)));
  expect(onAdd).not.toHaveBeenCalled();

  await act(async () => layer.dispatchEvent(pointer('pointerdown', 8, 10, 10)));
  await act(async () => layer.dispatchEvent(pointer('pointermove', 8, 30, 30)));
  await act(async () => layer.dispatchEvent(pointer('lostpointercapture', 8, 30, 30)));
  await act(async () => layer.dispatchEvent(pointer('pointerup', 8, 30, 30)));
  expect(onAdd).not.toHaveBeenCalled();
});
