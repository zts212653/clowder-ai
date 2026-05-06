import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CollectionCatalog } from '../CollectionCatalog';

const CATALOG_RESPONSE = {
  collections: [
    {
      manifest: { id: 'world:pilot', displayName: 'Pilot World', kind: 'world', sensitivity: 'internal' },
      overview: { docCount: 3, topKinds: [{ kind: 'research', count: 3 }], recentAnchors: [] },
      health: { indexFreshness: '2026-05-04', pendingReviewCount: 0 },
    },
  ],
};

const DOCUMENTS_RESPONSE = {
  collectionId: 'world:pilot',
  groups: [
    {
      kind: 'research',
      count: 3,
      hasMore: false,
      documents: [
        { anchor: 'alpha', title: 'Alpha Doc', updatedAt: '2026-05-04', status: 'indexed' },
        { anchor: 'beta', title: 'Beta Doc', updatedAt: '2026-05-03', status: 'indexed' },
        { anchor: 'gamma', title: 'Gamma Doc', updatedAt: '2026-05-02', status: 'indexed' },
      ],
    },
  ],
};

describe('CollectionCatalog expand/collapse', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url === '/api/library/catalog') {
          return Promise.resolve({ json: () => Promise.resolve(CATALOG_RESPONSE) });
        }
        if (url.includes('/documents')) {
          return Promise.resolve({ json: () => Promise.resolve(DOCUMENTS_RESPONSE) });
        }
        return Promise.resolve({ json: () => Promise.resolve({}) });
      }),
    );
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  it('click header → expand; click detail interior → stays expanded; click header → collapse', async () => {
    await act(async () => {
      root.render(<CollectionCatalog />);
    });
    // Wait for catalog fetch
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    const card = container.querySelector('[data-testid="collection-card-world:pilot"]') as HTMLElement;
    expect(card).not.toBeNull();

    const headerBtn = card.querySelector('button[aria-expanded]') as HTMLButtonElement;
    expect(headerBtn).not.toBeNull();
    expect(headerBtn.getAttribute('aria-expanded')).toBe('false');

    // Step 1: click header → detail appears
    await act(async () => {
      headerBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(headerBtn.getAttribute('aria-expanded')).toBe('true');

    // Wait for documents fetch
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    const detail = card.querySelector('[data-testid="collection-detail-world:pilot"]') as HTMLElement;
    expect(detail).not.toBeNull();

    // Step 2: click inside detail area → detail stays (no collapse)
    const docItem = detail.querySelector('li') as HTMLElement;
    expect(docItem).not.toBeNull();
    await act(async () => {
      docItem.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(headerBtn.getAttribute('aria-expanded')).toBe('true');
    expect(card.querySelector('[data-testid="collection-detail-world:pilot"]')).not.toBeNull();

    // Step 3: click header again → collapse
    await act(async () => {
      headerBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(headerBtn.getAttribute('aria-expanded')).toBe('false');
    expect(card.querySelector('[data-testid="collection-detail-world:pilot"]')).toBeNull();
  });
});
