import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DossierCatEntry } from '@/hooks/useDossierProfiles';
import { CatDossierContent } from '../CatDossierContent';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('@/utils/api-client', () => ({ apiFetch }));
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  root = createRoot(host);
  apiFetch.mockReset();
});
afterEach(() => {
  act(() => root.unmount());
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

describe('CatDossierContent evidence search', () => {
  it.each([
    ['nickname', { nickname: '宪宪' }, '宪宪'],
    ['missing nickname', {}, '布偶猫'],
    ['empty nickname', { nickname: '' }, '布偶猫'],
  ] as const)('searches with the displayed cat’s %s', async (_label, overrides, expected) => {
    const snippet = '证据片段很长很长。'.repeat(40);
    const cat: DossierCatEntry = { catId: 'opus', displayName: '布偶猫', dossier: null, ...overrides };
    apiFetch.mockImplementation(async (url: string) => {
      const data =
        url === '/api/dossier'
          ? {
              modelGroups: [{ model: 'test-model', cats: [cat] }],
              meta: { totalCats: 1, totalModels: 1, dossierCoverage: 0 },
            }
          : url === '/api/dossier/observations'
            ? { observations: {} }
            : {
                results: [
                  {
                    anchor: 'a1',
                    title: 'T1',
                    snippet,
                    matchRank: 'high',
                    authority: 'validated',
                    updatedAt: '2026-01-01',
                  },
                ],
              };
      return new Response(JSON.stringify(data));
    });
    await act(async () => root.render(<CatDossierContent />));
    expect(apiFetch.mock.calls.some(([url]) => String(url).startsWith('/api/evidence/search'))).toBe(false);
    const expand = [...host.querySelectorAll('button')].find((node) => node.textContent?.includes('最近证据'));
    expect(expand).toBeDefined();
    await act(async () => expand!.click());
    const blocks = [...host.querySelectorAll('[data-overflow-measure="block"]')];
    expect(blocks.map((node) => node.textContent)).toContain(snippet);
    expect(apiFetch).toHaveBeenCalledWith(
      `/api/evidence/search?q=${encodeURIComponent(expected)}&scope=threads&mode=hybrid&limit=5`,
    );
  });
});

// provenance.type = 'cvo' is asserted where observations are actually created:
// packages/api/test/dossier-observation-{routes,store,redis-store}.test.js.
