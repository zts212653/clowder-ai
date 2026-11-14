// @vitest-environment jsdom
/**
 * F071-D1: Regression tests for the shared Lightbox component.
 *
 * Tests:
 * 1. Renders image with correct src and alt
 * 2. Clicking backdrop (outer div) calls onClose
 * 3. Escape key calls onClose
 * 4. Clicking inner content does NOT close (stopPropagation)
 * 5. Renders caption when provided
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CopyButton, Lightbox } from '@/components/Lightbox';
import { writeShellLanguage } from '@/components/shell/shell-language';
import { writeShellPresentation } from '@/components/shell/shell-presentation';

const copy = vi.hoisted(() => ({ pixels: vi.fn() }));
// OS clipboard/canvas I/O stops here; the shared FileActions controller and its live copy are real.
vi.mock('@/components/content-review/file-action-client', async (original) => ({
  ...(await original<typeof import('@/components/content-review/file-action-client')>()),
  copyArtworkPixels: copy.pixels,
}));

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { React?: typeof React }).React = React;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  delete (globalThis as { React?: typeof React }).React;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

beforeEach(() => {
  localStorage.clear();
  writeShellPresentation('classic');
  writeShellLanguage('zh');
  copy.pixels.mockReset().mockResolvedValue(undefined);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  localStorage.clear();
});

function renderLightbox(props: Partial<React.ComponentProps<typeof Lightbox>> = {}) {
  const onClose = props.onClose ?? vi.fn();
  act(() => {
    root.render(
      React.createElement(Lightbox, {
        url: '/test-image.png',
        alt: 'test image',
        onClose,
        ...props,
      }),
    );
  });
  return { onClose };
}

it.each([
  ['v2', 'zh', '复制图片', '已复制图片'],
  ['v2', 'en', 'Copy image', 'Image copied'],
  ['classic', 'zh', '复制图片', '已复制图片'],
] as const)('uses %s/%s for the shared image copy action and successful feedback', async (presentation, language, label, copied) => {
  writeShellPresentation(presentation);
  writeShellLanguage(language);
  await act(async () => root.render(React.createElement(CopyButton, { url: '/test-image.png', placement: 'below' })));
  expect(container.textContent).toBe(label);
  expect(container.querySelector('button')?.title).toBe(label);
  await act(async () => container.querySelector('button')?.click());
  expect(copy.pixels).toHaveBeenCalledExactlyOnceWith(expect.any(HTMLImageElement), '/test-image.png');
  expect(container.textContent).toBe(copied);
});

it('translates a pending copy and its eventual result without remounting or repeating the action', async () => {
  let finish!: () => void;
  copy.pixels.mockReturnValue(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  await act(async () => root.render(React.createElement(CopyButton, { url: '/original.png' })));
  const button = container.querySelector('button')!;
  await act(async () => button.click());
  expect(button.textContent).toBe('复制图片');
  await act(async () => writeShellLanguage('en'));
  expect(container.querySelector('button')).toBe(button);
  expect(button.textContent).toBe('Copy image');
  await act(async () => finish());
  expect(button.textContent).toBe('Image copied');
  await act(async () => writeShellLanguage('zh'));
  expect(button.textContent).toBe('已复制图片');
  expect(copy.pixels).toHaveBeenCalledExactlyOnceWith(expect.any(HTMLImageElement), '/original.png');
});

it('keeps clipboard failure distinct from a copied image', async () => {
  copy.pixels.mockRejectedValue(new Error('clipboard denied'));
  await act(async () => root.render(React.createElement(CopyButton, { url: '/original.png' })));
  await act(async () => container.querySelector('button')!.click());
  expect(container.textContent).toBe('操作未完成，请重试。');
  expect(copy.pixels).toHaveBeenCalledOnce();
});

describe('Lightbox', () => {
  it('renders image with correct src and alt', () => {
    renderLightbox({ url: '/my-image.png', alt: 'my alt' });
    const img = document.body.querySelector('img');
    expect(img).toBeDefined();
    expect(img?.getAttribute('src')).toBe('/my-image.png');
    expect(img?.getAttribute('alt')).toBe('my alt');
  });

  it('renders the dialog outside the caller container to avoid hover flicker', () => {
    renderLightbox();
    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog).toBeDefined();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('calls onClose when Escape key is pressed', () => {
    const { onClose } = renderLightbox();
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when backdrop is clicked', () => {
    const { onClose } = renderLightbox();
    const backdrop = document.body.querySelector('[role="dialog"]');
    expect(backdrop).toBeDefined();
    act(() => {
      backdrop?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does NOT call onClose when image content is clicked', () => {
    const { onClose } = renderLightbox();
    const img = document.body.querySelector('img');
    expect(img).toBeDefined();
    act(() => {
      img?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    // Click on image should be stopped by stopPropagation on inner container
    expect(onClose).not.toHaveBeenCalled();
  });

  it('renders caption when provided', () => {
    renderLightbox({ caption: 'My caption text' });
    expect(document.body.innerHTML).toContain('My caption text');
  });

  it('does not render caption when not provided', () => {
    renderLightbox();
    const paragraphs = document.body.querySelectorAll('p');
    expect(paragraphs.length).toBe(0);
  });

  it('has close button that calls onClose', () => {
    const { onClose } = renderLightbox();
    const closeBtn = document.body.querySelector('button[title="Close"]');
    expect(closeBtn).toBeDefined();
    act(() => {
      closeBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
