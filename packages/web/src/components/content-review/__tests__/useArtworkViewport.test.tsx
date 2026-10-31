import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useArtworkViewport } from '../useArtworkViewport';

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(element: HTMLElement) {
        Object.defineProperties(element, { clientWidth: { value: 600 }, clientHeight: { value: 500 } });
      }
      disconnect() {}
    },
  );
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
function Artwork({ scroll = true, gallery = false }: { scroll?: boolean; gallery?: boolean }) {
  const ref = useRef<HTMLElement>(null);
  const viewport = useArtworkViewport(ref, { width: 840, height: 1552 }, 1, scroll, gallery);
  return (
    <>
      <button onClick={viewport.actual}>100%</button>
      <button data-testid="pan" onClick={() => viewport.setPanMode(true)}>
        Pan
      </button>
      <section ref={ref} {...viewport.handlers}>
        <button data-testid="gallery-control">Next artwork</button>
        <div
          data-testid="stage"
          data-scale={viewport.renderedScale}
          data-y={viewport.offset.y}
          style={viewport.stageStyle}
        />
      </section>
    </>
  );
}
it('opens a long image at its first line at 100% and scrolls to the last line without changing scale', async () => {
  await act(async () => root.render(<Artwork />));
  await act(async () => container.querySelector('button')!.click());
  const stage = container.querySelector<HTMLElement>('[data-testid="stage"]')!;
  expect(Number(stage.dataset.scale)).toBe(1);
  expect(Number(stage.dataset.y)).toBe((1552 - 500) / 2);
  expect(stage.style.transform).toBe('translate(120px, 526px)');
  const wheel = new WheelEvent('wheel', { deltaY: 2000, bubbles: true, cancelable: true });
  await act(async () => container.querySelector('section')!.dispatchEvent(wheel));
  expect(wheel.defaultPrevented, 'native scrolling must remain inside the transformed image viewport').toBe(true);
  expect(Number(stage.dataset.scale)).toBe(1);
  expect(Number(stage.dataset.y)).toBe(-(1552 - 500) / 2);
});
it('keeps the existing wheel zoom for video and other artwork consumers', async () => {
  await act(async () => root.render(<Artwork scroll={false} />));
  await act(async () => container.querySelector('button')!.click());
  await act(async () =>
    container
      .querySelector('section')!
      .dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true })),
  );
  expect(Number(container.querySelector<HTMLElement>('[data-testid="stage"]')!.dataset.scale)).toBeLessThan(1);
});

it('lets a horizontal gesture reach gallery paging until the image needs horizontal panning', async () => {
  await act(async () => root.render(<Artwork gallery />));
  const section = container.querySelector('section')!;
  const fitted = new WheelEvent('wheel', { deltaX: 90, bubbles: true, cancelable: true });
  await act(async () => section.dispatchEvent(fitted));
  expect(fitted.defaultPrevented, 'a fitted gallery image must not swallow its parent paging gesture').toBe(false);
  await act(async () => container.querySelector('button')!.click());
  const zoomed = new WheelEvent('wheel', { deltaX: 90, bubbles: true, cancelable: true });
  await act(async () => section.dispatchEvent(zoomed));
  expect(zoomed.defaultPrevented).toBe(true);
  expect(container.querySelector<HTMLElement>('[data-testid="stage"]')!.style.transform).toBe('translate(30px, 526px)');
});

it('keeps gallery buttons clickable while image panning is active', async () => {
  await act(async () => root.render(<Artwork gallery />));
  await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="pan"]')!.click());
  const section = container.querySelector('section')!;
  section.setPointerCapture = vi.fn();
  const pointer = new Event('pointerdown', { bubbles: true, cancelable: true });
  Object.defineProperties(pointer, {
    button: { value: 0 },
    pointerId: { value: 1 },
    clientX: { value: 10 },
    clientY: { value: 10 },
  });
  await act(async () => container.querySelector('[data-testid="gallery-control"]')!.dispatchEvent(pointer));
  expect(pointer.defaultPrevented, 'pressing a gallery control must not start image panning').toBe(false);
  expect(section.setPointerCapture).not.toHaveBeenCalled();
});

it('keeps a fitted landscape picture and its dock near the top of a tall image desk', async () => {
  function Landscape() {
    const ref = useRef<HTMLElement>(null);
    const viewport = useArtworkViewport(ref, { width: 1200, height: 600 }, 1, true);
    return (
      <section ref={ref}>
        <output>{viewport.mediaBottom}</output>
      </section>
    );
  }
  await act(async () => root.render(<Landscape />));
  expect(Number(container.querySelector('output')?.textContent)).toBe(300);
});
