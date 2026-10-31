import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const CURRENT_CATS = [{ id: 'cat-sol', displayName: '缅因猫', variantLabel: 'sol' }];

vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    cats: CURRENT_CATS,
    getCatById: (id: string) => CURRENT_CATS.find((cat) => cat.id === id),
  }),
}));

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '@/utils/api-client';
import { HubToolUsageTab } from '../HubToolUsageTab';

const REPORT_WITH_RETIRED_MEMBER = {
  period: { from: '2026-01-01', to: '2026-07-20' },
  summary: { totalCalls: 3, byCategory: { native: 3 } },
  topTools: [],
  daily: [],
  byCat: {
    'cat-sol': { native: 2 },
    'cat-retired': { native: 1 },
  },
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('HubToolUsageTab member filter', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    Object.assign(globalThis as Record<string, unknown>, { React, IS_REACT_ACT_ENVIRONMENT: true });
  });

  afterAll(() => {
    delete (globalThis as Record<string, unknown>).React;
    delete (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.mocked(apiFetch).mockReset();
  });

  it('keeps members found only in the historical report available as raw-ID filter options', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(jsonResponse(REPORT_WITH_RETIRED_MEMBER))
      .mockResolvedValueOnce(
        jsonResponse({
          ...REPORT_WITH_RETIRED_MEMBER,
          summary: { totalCalls: 1, byCategory: { native: 1 } },
          byCat: { 'cat-retired': { native: 1 } },
        }),
      );
    await act(async () => {
      root.render(<HubToolUsageTab />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    const memberSelect = container.querySelector('select');
    const options = Array.from(memberSelect?.querySelectorAll('option') ?? []).map((option) => ({
      value: option.value,
      label: option.textContent,
    }));

    expect(options).toEqual([
      { value: '', label: '全部猫猫' },
      { value: 'cat-sol', label: '缅因猫（sol）' },
      { value: 'cat-retired', label: 'cat-retired' },
    ]);

    await act(async () => {
      if (memberSelect) {
        memberSelect.value = 'cat-retired';
        memberSelect.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(apiFetch).toHaveBeenLastCalledWith(expect.stringContaining('catId=cat-retired'));
    expect(container.querySelector('select')?.value).toBe('cat-retired');
  });
});
