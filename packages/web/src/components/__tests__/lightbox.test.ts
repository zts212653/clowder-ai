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
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
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
  ['v2', 'zh', '复制', '复制图片', '已复制'],
  ['v2', 'en', 'Copy', 'Copy image', 'Copied!'],
  ['classic', 'zh', 'Copy', 'Copy image', 'Copied!'],
] as const)('uses %s/%s for the image copy action and successful feedback', async (presentation, language, copy, title, copied) => {
  writeShellPresentation(presentation);
  writeShellLanguage(language);
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  await act(async () => root.render(React.createElement(CopyButton, { url: '/test-image.png', placement: 'below' })));
  expect(container.textContent).toBe(copy);
  expect(container.querySelector('button')?.title).toBe(title);
  await act(async () => container.querySelector('button')?.click());
  expect(writeText).toHaveBeenCalledWith('/test-image.png');
  expect(container.textContent).toBe(copied);
  await act(async () => writeShellPresentation('classic'));
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
