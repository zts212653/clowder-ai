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
});
