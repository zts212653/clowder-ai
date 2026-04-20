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

function minimalCat(id: string): import('@/hooks/useCatData').CatData {
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
    source: 'seed',
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
