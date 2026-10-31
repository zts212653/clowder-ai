import { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useArtworkGalleryNavigation } from '@/components/content-review/ArtworkGalleryNavigation';
import { Lightbox } from '@/components/Lightbox';
import { writeShellLanguage } from '@/components/shell/shell-language';
import { writeShellPresentation } from '@/components/shell/shell-presentation';

const items = Array.from({ length: 3 }, (_, index) => ({
  url: `/original-${index + 1}.png`,
  title: `original-${index + 1}.png`,
  alt: `original-${index + 1}.png`,
  mediaType: 'image' as const,
  caption: `原说明 ${index + 1}`,
}));

it('only lets the active retained work pane handle arrows when focus returns to the document', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const current = vi.fn(),
    retained = vi.fn();
  function Pane({ hidden, onSelect }: { hidden: boolean; onSelect: (index: number) => void }) {
    const ref = useRef<HTMLElement>(null);
    useArtworkGalleryNavigation({ items, index: 1, onSelect }, ref);
    return (
      <section ref={ref} aria-hidden={hidden}>
        Retained artwork pane
      </section>
    );
  }
  try {
    await act(async () =>
      root.render(
        <>
          <Pane hidden onSelect={retained} />
          <Pane hidden={false} onSelect={current} />
        </>,
      ),
    );
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    await act(async () =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', cancelable: true })),
    );
    expect(current).toHaveBeenCalledExactlyOnceWith(2);
    expect(retained, 'an inactive pane cannot issue a second page transition').not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it('shows the opened position and bounded arrows, without consuming text-input or IME navigation', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const onSelect = vi.fn(),
    onClose = vi.fn();
  const render = (index: number) =>
    act(async () =>
      root.render(
        <Lightbox
          url={items[index].url}
          alt={items[index].alt}
          caption={items[index].caption}
          composerSlot={<textarea aria-label="同一份草稿" defaultValue="不要丢" />}
          gallery={{ items, index, onSelect }}
          onClose={onClose}
        />,
      ),
    );
  try {
    writeShellPresentation('v2');
    writeShellLanguage('zh');
    await render(1);
    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain('2 / 3');
    expect(dialog.textContent).toContain('原说明 2');
    const previous = dialog.querySelector<HTMLButtonElement>('button[aria-label="上一件作品"]');
    const next = dialog.querySelector<HTMLButtonElement>('button[aria-label="下一件作品"]');
    expect(previous).toBeTruthy();
    expect(next).toBeTruthy();
    await act(async () => previous!.click());
    expect(onSelect).toHaveBeenLastCalledWith(0);
    await act(async () => next!.click());
    expect(onSelect).toHaveBeenLastCalledWith(2);
    onSelect.mockClear();
    const composer = dialog.querySelector('textarea')!;
    composer.focus();
    await act(async () => composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
    await act(async () =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', isComposing: true })),
    );
    expect(onSelect).not.toHaveBeenCalled();
    await render(0);
    expect(document.body.querySelector<HTMLButtonElement>('button[aria-label="上一件作品"]')?.disabled).toBe(true);
    dialog.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' })));
    expect(onSelect).not.toHaveBeenCalled();
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' })));
    expect(onSelect).toHaveBeenLastCalledWith(1);
    expect(composer.value).toBe('不要丢');
    expect(onClose).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    writeShellPresentation('classic');
    writeShellLanguage('zh');
  }
});
