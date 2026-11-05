/**
 * F166 Task 5: CatOverviewTab drag-to-reorder integration test.
 * Drops cat B onto cat A → saveCatOrder is called with new order.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const saveCatOrderMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('@/hooks/useCatData', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/useCatData')>('@/hooks/useCatData');
  return { ...actual, saveCatOrder: saveCatOrderMock };
});

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn().mockResolvedValue({ ok: false }),
}));

const { CatOverviewTab } = await import('../config-viewer-tabs');
const { apiFetch } = await import('@/utils/api-client');

function minimalCat(id: string, sessionChain?: boolean): import('@/hooks/useCatData').CatData {
  return {
    id,
    displayName: id.toUpperCase(),
    color: { primary: '#000', secondary: '#fff' },
    mentionPatterns: [`@${id}`],
    clientId: 'anthropic',
    defaultModel: 'model',
    avatar: '',
    roleDescription: '',
    personality: '',
    ...(sessionChain !== undefined ? { sessionChain } : {}),
  } as import('@/hooks/useCatData').CatData;
}

function makeDragEvent(type: string, dataTransfer: Partial<DataTransfer>): DragEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
  return event;
}

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});
beforeEach(() => {
  saveCatOrderMock.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('CatOverviewTab drag & drop (F166)', () => {
  for (const staleFailure of [false, true])
    it(`keeps confirmed preference after an interleaved GET (failure=${staleFailure})`, async () => {
      const mock = vi.mocked(apiFetch);
      const original = mock.getMockImplementation();
      let finishPut: ((response: Response) => void) | undefined;
      let finishRead: ((response: Response) => void) | undefined;
      let reads = 0;
      mock.mockImplementation(async (url, init) => {
        if (String(url) !== '/api/config/default-cat') return new Response('{}');
        if (init?.method === 'PUT')
          return new Promise<Response>((resolve) => {
            finishPut = resolve;
          });
        if (++reads === 1) return new Response(JSON.stringify({ catId: 'A' }));
        return new Promise<Response>((resolve) => {
          finishRead = resolve;
        });
      });
      try {
        const config = { coCreator: null, cats: {} } as unknown as import('../config-viewer-types').ConfigData;
        const cats = [minimalCat('A'), minimalCat('B')];
        await act(async () => root.render(React.createElement(CatOverviewTab, { config, cats })));
        const select = container.querySelector('[data-testid="default-cat-select"]') as HTMLSelectElement;
        await act(async () => {
          select.value = 'B';
          select.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await act(async () => root.render(React.createElement(CatOverviewTab, { config, cats: [...cats] })));
        await act(async () => finishPut?.(new Response('{}')));
        expect(select.value).toBe('B');
        await act(async () =>
          finishRead?.(new Response(staleFailure ? 'invalid-json' : JSON.stringify({ catId: 'A' }))),
        );
        expect(select.value).toBe('B');
        expect(container.textContent).not.toContain('加载失败，当前默认猫未知');
      } finally {
        if (original) mock.mockImplementation(original);
      }
    });

  it('ignores an older default response that arrives after the first registered roster', async () => {
    const mock = vi.mocked(apiFetch);
    const original = mock.getMockImplementation();
    let completeFirst: ((response: Response) => void) | undefined;
    let calls = 0;
    mock.mockImplementation(async (url) => {
      if (String(url) !== '/api/config/default-cat') return new Response('{}');
      if (++calls === 1)
        return new Promise<Response>((resolve) => {
          completeFirst = resolve;
        });
      return new Response(JSON.stringify({ catId: 'A' }));
    });
    try {
      const config = { coCreator: null, cats: {} } as unknown as import('../config-viewer-types').ConfigData;
      await act(async () => root.render(React.createElement(CatOverviewTab, { config, cats: [] })));
      await act(async () => root.render(React.createElement(CatOverviewTab, { config, cats: [minimalCat('A')] })));
      await act(async () => completeFirst?.(new Response(JSON.stringify({ catId: 'legacy-default' }))));
      expect((container.querySelector('[data-testid="default-cat-select"]') as HTMLSelectElement).value).toBe('A');
    } finally {
      if (original) mock.mockImplementation(original);
    }
  });

  it('refreshes the resolved default after the first members are registered without changing the preference', async () => {
    const mock = vi.mocked(apiFetch);
    const original = mock.getMockImplementation();
    let registered = false;
    const requests: string[] = [];
    mock.mockImplementation(async (url, init) => {
      requests.push(`${init?.method ?? 'GET'} ${url}`);
      return new Response(
        JSON.stringify(String(url) === '/api/config/default-cat' ? { catId: registered ? 'A' : 'legacy-default' } : {}),
      );
    });
    try {
      const config = { coCreator: null, cats: {} } as unknown as import('../config-viewer-types').ConfigData;
      await act(async () => root.render(React.createElement(CatOverviewTab, { config, cats: [] })));
      registered = true;
      await act(async () => root.render(React.createElement(CatOverviewTab, { config, cats: [minimalCat('A')] })));
      expect((container.querySelector('[data-testid="default-cat-select"]') as HTMLSelectElement).value).toBe('A');
      expect(requests.filter((request) => request === 'GET /api/config/default-cat')).toHaveLength(2);
      expect(requests.some((request) => request.startsWith('PUT '))).toBe(false);
    } finally {
      if (original) mock.mockImplementation(original);
    }
  });

  it('keeps the selected account visible when model preferences inherit from the tool', async () => {
    const cats = [
      {
        ...minimalCat('A'),
        configurationSource: 'native_tool' as const,
        accountRef: 'company-codex',
        clientId: 'openai',
        defaultModel: '',
      },
    ];
    const config = { coCreator: null, cats: {} } as unknown as import('../config-viewer-types').ConfigData;
    await act(async () => {
      root.render(React.createElement(CatOverviewTab, { config, cats }));
    });
    expect(container.querySelector('[data-testid="cat-card-A"]')?.textContent).toContain('company-codex');
  });
  it('omits repetitive session-chain implementation badges regardless of the legacy byte', async () => {
    const cats = [minimalCat('A', true), minimalCat('B', false)];
    const config = { coCreator: null, cats: {} } as unknown as import('../config-viewer-types').ConfigData;

    await act(async () => {
      root.render(React.createElement(CatOverviewTab, { config, cats }));
    });

    expect(container.querySelector('[data-testid="cat-card-A"]')?.textContent).not.toContain('Session Chain 始终可见');
    expect(container.querySelector('[data-testid="cat-card-B"]')?.textContent).not.toContain('Session Chain 始终可见');
  });

  it('rolls back local order and shows error when saveCatOrder rejects', async () => {
    saveCatOrderMock.mockRejectedValueOnce(new Error('boom'));
    const cats = [minimalCat('A'), minimalCat('B'), minimalCat('C')];
    const config = { coCreator: null, cats: {} } as unknown as import('../config-viewer-types').ConfigData;

    await act(async () => {
      root.render(React.createElement(CatOverviewTab, { config, cats }));
    });

    const cardA = container.querySelector('[data-testid="cat-card-A"]') as HTMLElement;
    const cardB = container.querySelector('[data-testid="cat-card-B"]') as HTMLElement;
    const store = { 'text/plain': '' };
    const dataTransfer = {
      setData: (type: string, value: string) => {
        store[type as 'text/plain'] = value;
      },
      getData: (type: string) => store[type as 'text/plain'] ?? '',
    } as unknown as DataTransfer;

    await act(async () => {
      cardB.dispatchEvent(makeDragEvent('dragstart', dataTransfer));
      cardA.dispatchEvent(makeDragEvent('dragover', dataTransfer));
      cardA.dispatchEvent(makeDragEvent('drop', dataTransfer));
    });
    // Let the rejected save settle and trigger rollback render.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Order reverts to A, B, C (initial).
    const ids = Array.from(container.querySelectorAll('[data-testid^="cat-card-"]')).map((el) =>
      el.getAttribute('data-testid'),
    );
    expect(ids).toEqual(['cat-card-A', 'cat-card-B', 'cat-card-C']);
    // Error message is shown.
    expect(container.textContent).toMatch(/排序保存失败/);
  });

  it('dragging cat B onto cat A calls saveCatOrder with new order ["B","A","C"]', async () => {
    const cats = [minimalCat('A'), minimalCat('B'), minimalCat('C')];
    const config = { coCreator: null, cats: {} } as unknown as import('../config-viewer-types').ConfigData;

    await act(async () => {
      root.render(React.createElement(CatOverviewTab, { config, cats }));
    });

    const cardA = container.querySelector('[data-testid="cat-card-A"]') as HTMLElement;
    const cardB = container.querySelector('[data-testid="cat-card-B"]') as HTMLElement;
    expect(cardA).toBeTruthy();
    expect(cardB).toBeTruthy();

    const store = { 'text/plain': '' };
    const dataTransfer = {
      setData: (type: string, value: string) => {
        store[type as 'text/plain'] = value;
      },
      getData: (type: string) => store[type as 'text/plain'] ?? '',
    } as unknown as DataTransfer;

    await act(async () => {
      cardB.dispatchEvent(makeDragEvent('dragstart', dataTransfer));
      cardA.dispatchEvent(makeDragEvent('dragover', dataTransfer));
      cardA.dispatchEvent(makeDragEvent('drop', dataTransfer));
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(saveCatOrderMock).toHaveBeenCalledWith(['B', 'A', 'C']);
  });
});
