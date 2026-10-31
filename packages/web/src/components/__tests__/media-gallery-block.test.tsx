import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MediaGalleryBlock } from '@/components/rich/MediaGalleryBlock';
import { writeShellLanguage } from '@/components/shell/shell-language';
import type { RichMediaGalleryBlock } from '@/stores/chat-types';
import { API_URL, apiFetch } from '@/utils/api-client';

vi.mock('@/utils/api-client', () => ({ API_URL: 'http://localhost:3102', apiFetch: vi.fn() }));

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
  vi.mocked(apiFetch).mockReset();
  writeShellLanguage('zh');
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
    expect(errorEl?.textContent).toContain('图片地址无法打开');
    expect(errorEl?.querySelector('button')).toBeNull();
    // The <img> should be gone, replaced by the placeholder
    expect(container.querySelector('img')).toBeNull();
  });

  it('uses the API origin for workspace images in classic too', () => {
    const url = '/api/workspace/file/raw?worktreeId=cat-cafe&path=docs/image.png';
    renderBlock([{ url }]);
    expect(container.querySelector('img')?.getAttribute('src')).toBe(`${API_URL}${url}`);
  });

  it('safely resolves historical local paths before requesting an image', async () => {
    vi.mocked(apiFetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          worktreeId: 'cat-cafe',
          path: 'docs/a #100%.png',
          kind: 'file',
          line: null,
        }),
      ),
    );
    await act(async () => renderBlock([{ url: '/home/user/cat-cafe/docs/a #100%.png' }]));
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/workspace/resolve-document-link',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ href: '/home/user/cat-cafe/docs/a #100%.png' }),
      }),
    );
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      `${API_URL}/api/workspace/file/raw?worktreeId=cat-cafe&path=docs%2Fa+%23100%25.png`,
    );
  });

  it('shows a permanent address error when a historical path is rejected', async () => {
    vi.mocked(apiFetch).mockResolvedValue(new Response('{}', { status: 403 }));
    await act(async () => renderBlock([{ url: '/home/user/secret.png' }]));
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[data-testid="media-gallery-error"]')?.textContent).toContain('图片地址无法打开');
    expect(container.querySelector('[data-testid="media-gallery-error"] button')).toBeNull();
  });

  it('uses English copy when the shell language is English', () => {
    writeShellLanguage('en');
    renderBlock([{ url: '/uploads/missing.png' }]);
    act(() => container.querySelector('img')?.dispatchEvent(new Event('error')));
    expect(container.textContent).toContain('Image address could not be opened');
    expect(container.textContent).not.toContain('重试');
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
