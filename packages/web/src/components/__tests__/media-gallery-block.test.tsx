import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MediaGalleryBlock } from '@/components/rich/MediaGalleryBlock';
import type { RichMediaGalleryBlock } from '@/stores/chat-types';
import { API_URL } from '@/utils/api-client';

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

function renderBlock(items: RichMediaGalleryBlock['items']) {
  const block: RichMediaGalleryBlock = {
    id: 'mg1',
    kind: 'media_gallery',
    v: 1,
    title: 'gallery',
    items,
  };
  act(() => {
    root.render(React.createElement(MediaGalleryBlock, { block }));
  });
}

describe('MediaGalleryBlock', () => {
  it('prefixes API_URL for uploads images', () => {
    renderBlock([{ url: '/uploads/test.png', alt: 'upload' }]);
    const img = container.querySelector('img');
    expect(img?.getAttribute('src')).toBe(`${API_URL}/uploads/test.png`);
  });

  it('prefixes API_URL for connector-media images', () => {
    renderBlock([{ url: '/api/connector-media/test.png', alt: 'connector' }]);
    const img = container.querySelector('img');
    expect(img?.getAttribute('src')).toBe(`${API_URL}/api/connector-media/test.png`);
  });

  it('leaves external urls unchanged', () => {
    renderBlock([{ url: 'https://example.com/test.png', alt: 'external' }]);
    const img = container.querySelector('img');
    expect(img?.getAttribute('src')).toBe('https://example.com/test.png');
  });

  it('shows error placeholder when image fails to load', () => {
    renderBlock([{ url: '/uploads/missing.png', alt: 'gone' }]);
    const img = container.querySelector('img');
    expect(img).toBeTruthy();

    // Simulate the browser firing an error event (404)
    act(() => {
      img?.dispatchEvent(new Event('error'));
    });

    const errorEl = container.querySelector('[data-testid="media-gallery-error"]');
    expect(errorEl).toBeTruthy();
    expect(errorEl?.textContent).toContain('Image failed to load');
    expect(errorEl?.textContent).toContain('/uploads/missing.png');
    // The <img> should be gone, replaced by the placeholder
    expect(container.querySelector('img')).toBeNull();
  });

  it('still shows other images when one fails', () => {
    renderBlock([
      { url: '/uploads/ok.png', alt: 'good' },
      { url: '/uploads/broken.png', alt: 'bad' },
    ]);
    const imgs = container.querySelectorAll('img');
    expect(imgs.length).toBe(2);

    // Fail the second image
    act(() => {
      imgs[1].dispatchEvent(new Event('error'));
    });

    // First image still present, second replaced
    expect(container.querySelectorAll('img').length).toBe(1);
    expect(container.querySelector('[data-testid="media-gallery-error"]')).toBeTruthy();
  });
});
