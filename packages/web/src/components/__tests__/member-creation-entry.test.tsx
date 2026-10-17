import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { MemberCreationPage } from '../settings/members/MemberCreationPage';

const state = vi.hoisted(() => ({ hasFetched: false, isLoading: true, query: 'view=add', replace: vi.fn() }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(state.query),
  useRouter: () => ({ replace: state.replace }),
}));
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ ...state, refresh: vi.fn() }) }));
vi.mock('../settings/members/MemberSettingsPage', () => ({ MemberSettingsPage: () => <p>单个伙伴配置</p> }));
vi.mock('../settings/members/RecommendedTeamSetup', () => ({
  RecommendedTeamSetup: ({ onManual }: { onManual: () => void }) => (
    <div>
      默认团队推荐
      <button type="button" onClick={onManual}>
        手动创建
      </button>
    </div>
  ),
}));
let root: Root, host: HTMLDivElement;
const back = vi.fn();
const render = (cats: CatData[] = []) =>
  act(async () =>
    root.render(
      <MemberCreationPage cats={cats} onBack={back} onSaved={async () => {}} onTeamCreated={async () => {}} />,
    ),
  );
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.hasFetched = false;
  state.isLoading = true;
  state.query = 'view=add';
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it('keeps ordinary add usable without waiting for discovery or an empty roster', async () => {
  await render();
  expect(host.textContent).toContain('单个伙伴配置');
  state.hasFetched = true;
  state.isLoading = false;
  await render();
  expect(host.textContent).toContain('单个伙伴配置');
  await render([{ id: 'just-created' } as CatData]);
  expect(host.textContent).toContain('单个伙伴配置');
});

it('preserves the ordinary single-member editor for an existing team', async () => {
  state.hasFetched = true;
  state.isLoading = false;
  await render([{ id: 'existing' } as CatData]);
  expect(host.textContent).toContain('单个伙伴配置');
});

it('keeps the manual choice in the URL so a settings round trip does not restart setup', async () => {
  state.query = 's=members&view=setup&shell=v2';
  state.hasFetched = true;
  await render();
  act(() => host.querySelector('button')?.click());
  expect(host.textContent).toContain('单个伙伴配置');
  expect(state.replace).toHaveBeenCalledWith('/settings?s=members&view=add&shell=v2&manual=1', { scroll: false });
});

it('routes an existing team to its status list instead of automatic creation', async () => {
  state.query = 's=members&view=setup&shell=classic';
  state.hasFetched = true;
  await render([{ id: 'existing' } as CatData]);
  expect(host.textContent).not.toContain('默认团队推荐');
  expect(back).toHaveBeenCalledOnce();
});

it('waits for the initial roster, then preserves the zero-start journey as roles appear', async () => {
  state.query = 's=members&view=setup';
  await render();
  expect(host.textContent).not.toContain('默认团队推荐');
  state.hasFetched = true;
  await render();
  expect(host.textContent).toContain('默认团队推荐');
  await render([{ id: 'partially-created' } as CatData]);
  expect(host.textContent).toContain('默认团队推荐');
  expect(back).not.toHaveBeenCalled();
});
