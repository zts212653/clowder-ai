/**
 * F166: useCatData should apply /api/config/cat-order to the returned cats.
 * Uses project's createRoot + mocked apiFetch convention (no @testing-library/react).
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(),
}));
vi.mock('@/lib/mention-highlight', () => ({ refreshMentionData: vi.fn() }));
vi.mock('@/utils/transcription-corrector', () => ({ refreshSpeechAliases: vi.fn() }));

const { apiFetch } = await import('@/utils/api-client');
const { _resetCatDataCache, useCatData, saveCatOrder, getCachedCats } = await import('../useCatData');

function makeResponse(payload: unknown): Response {
  return { ok: true, json: () => Promise.resolve(payload) } as unknown as Response;
}

function wireApiFetch(responses: Record<string, unknown>) {
  (apiFetch as ReturnType<typeof vi.fn>).mockImplementation((path: string) => {
    const payload = responses[path];
    if (payload == null) return Promise.resolve({ ok: false } as Response);
    return Promise.resolve(makeResponse(payload));
  });
}

let captured: ReturnType<typeof useCatData> | null = null;

function HookHost() {
  captured = useCatData();
  return null;
}

let container: HTMLDivElement;
let root: Root;

describe('useCatData applies catOrder', () => {
  beforeEach(() => {
    _resetCatDataCache();
    vi.clearAllMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    captured = null;
  });

  it('reorders cats according to /api/config/cat-order', async () => {
    wireApiFetch({
      '/api/cats': { cats: [{ id: 'opus' }, { id: 'opus-47' }, { id: 'gpt52' }] },
      '/api/config/cat-order': { catOrder: ['opus-47', 'gpt52'] },
    });

    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(HookHost));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(captured?.cats.map((c) => c.id)).toEqual(['opus-47', 'gpt52', 'opus']);
  });

  it('leaves cats in original order when cat-order returns empty', async () => {
    wireApiFetch({
      '/api/cats': { cats: [{ id: 'opus' }, { id: 'opus-47' }, { id: 'gpt52' }] },
      '/api/config/cat-order': { catOrder: [] },
    });

    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(HookHost));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(captured?.cats.map((c) => c.id)).toEqual(['opus', 'opus-47', 'gpt52']);
  });

  it('stale saveCatOrder success does not overwrite newer save in cache', async () => {
    wireApiFetch({
      '/api/cats': { cats: [{ id: 'opus' }, { id: 'opus-47' }, { id: 'gpt52' }] },
      '/api/config/cat-order': { catOrder: [] },
    });

    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(HookHost));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    // Two concurrent saves — first slow, second fast
    let resolveFirst!: () => void;
    const firstBlocks = new Promise<void>((r) => {
      resolveFirst = r;
    });
    let callCount = 0;
    (apiFetch as ReturnType<typeof vi.fn>).mockImplementation((_path: string, opts?: RequestInit) => {
      if (opts?.method === 'PUT') {
        callCount++;
        if (callCount === 1) {
          // First save: blocks until we manually resolve
          return firstBlocks.then(() => makeResponse({ catOrder: ['gpt52', 'opus', 'opus-47'] }));
        }
        // Second save: resolves immediately
        return Promise.resolve(makeResponse({ catOrder: ['opus-47', 'gpt52', 'opus'] }));
      }
      return Promise.resolve({ ok: false } as Response);
    });

    const first = saveCatOrder(['gpt52', 'opus', 'opus-47']);
    const second = saveCatOrder(['opus-47', 'gpt52', 'opus']);
    await second;
    // Now the cache should have the second save's order
    expect(getCachedCats().map((c) => c.id)).toEqual(['opus-47', 'gpt52', 'opus']);

    // Let the first (stale) save complete
    resolveFirst();
    await first;
    // Cache must still reflect the SECOND (newer) save, not the first (stale) one
    expect(getCachedCats().map((c) => c.id)).toEqual(['opus-47', 'gpt52', 'opus']);
  });

  it('older success after newer failure still updates cache', async () => {
    wireApiFetch({
      '/api/cats': { cats: [{ id: 'opus' }, { id: 'opus-47' }, { id: 'gpt52' }] },
      '/api/config/cat-order': { catOrder: [] },
    });

    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(HookHost));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    let resolveFirst!: () => void;
    const firstBlocks = new Promise<void>((r) => {
      resolveFirst = r;
    });
    let callCount = 0;
    (apiFetch as ReturnType<typeof vi.fn>).mockImplementation((_path: string, opts?: RequestInit) => {
      if (opts?.method === 'PUT') {
        callCount++;
        if (callCount === 1) {
          return firstBlocks.then(() => makeResponse({ catOrder: ['gpt52', 'opus', 'opus-47'] }));
        }
        // Second save: immediate 500
        return Promise.resolve({ ok: false, status: 500 } as Response);
      }
      return Promise.resolve({ ok: false } as Response);
    });

    const first = saveCatOrder(['gpt52', 'opus', 'opus-47']);
    const second = saveCatOrder(['opus-47', 'gpt52', 'opus']).catch(() => {});
    await second;

    // Let the first (older but only successful) save complete
    resolveFirst();
    await first;
    // Cache should reflect order1 — the only successful backend write
    expect(getCachedCats().map((c) => c.id)).toEqual(['gpt52', 'opus', 'opus-47']);
  });
});
