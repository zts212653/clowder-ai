import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { apiFetch } from '@/utils/api-client';
import { MemberCreationPage } from '../settings/members/MemberCreationPage';

const registry = vi.hoisted(() => ({ hasFetched: true, isLoading: false }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams('s=members&view=add&manual=1&lang=zh'),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));
vi.mock('@/hooks/useCatData', async (load) => ({
  ...(await load<typeof import('@/hooks/useCatData')>()),
  useCatData: () => ({ ...registry, refresh: vi.fn() }),
}));
vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn(), API_URL: 'manual-entry-test' }));
vi.mock('../settings/members/MemberRuntimeFields', () => ({ MemberRuntimeFields: () => <p>运行工具</p> }));

let root: Root, host: HTMLDivElement;
let receiptFails = false;
const writes: string[] = [];
const saved = vi.fn();
const render = async (cats: CatData[] = []) =>
  act(async () =>
    root.render(<MemberCreationPage cats={cats} onBack={vi.fn()} onSaved={saved} onTeamCreated={vi.fn()} />),
  );
const clickSave = () =>
  act(async () => {
    const button = [...host.querySelectorAll('button')].find((node) => node.textContent === '添加伙伴');
    if (!button) throw Error('Expected the real manual create control');
    button.click();
  });
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  sessionStorage.clear();
  vi.clearAllMocks();
  writes.length = 0;
  receiptFails = false;
  registry.hasFetched = true;
  registry.isLoading = false;
  saved.mockResolvedValue(undefined);
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    if (init?.method) writes.push(`${init.method} ${url}`);
    if (url === '/api/config/onboarding/entry')
      return Response.json({ status: receiptFails ? 'error' : 'pending' }, { status: receiptFails ? 503 : 200 });
    if (url === '/api/accounts') return Response.json({ providers: [], projectPath: '/author-fixture' });
    if (url === '/api/session') return Response.json({ userId: 'author-fixture' });
    if (url === '/api/cat-templates') return Response.json({ templates: [] });
    if (url === '/api/cats' && init?.method === 'POST') {
      const payload = JSON.parse(String(init.body));
      return Response.json({ cat: { ...payload, id: payload.id ?? 'manual-fixture' } }, { status: 201 });
    }
    throw Error(`Unexpected request: ${url}`);
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function namePartner() {
  const input = [...host.querySelectorAll('input')].find((node) => node.closest('label')?.textContent === '名字');
  if (!input) throw Error('Expected the real manual name field');
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, '我的伙伴');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

it('arms the same personal entry reminder before the first manual member write', async () => {
  await render();
  await namePartner();
  await clickSave();
  expect(writes).toEqual(['PUT /api/config/onboarding/entry', 'POST /api/cats']);
  expect(saved).toHaveBeenCalledOnce();
});
it('retains the manual form on receipt failure and retries without creating a partial member', async () => {
  receiptFails = true;
  await render();
  await namePartner();
  await clickSave();
  expect(writes).toEqual(['PUT /api/config/onboarding/entry']);
  expect(saved).not.toHaveBeenCalled();
  expect(host.querySelector('[role=alert]')?.textContent).toContain('入口提醒');
  expect([...host.querySelectorAll('input')].some((input) => input.value === '我的伙伴')).toBe(true);
  receiptFails = false;
  await clickSave();
  expect(writes).toEqual(['PUT /api/config/onboarding/entry', 'PUT /api/config/onboarding/entry', 'POST /api/cats']);
  expect(saved).toHaveBeenCalledOnce();
});
it.each([false, true])('does not infer a first user from an unknown or existing roster (known=%s)', async (known) => {
  registry.hasFetched = known;
  await render(known ? [{ id: 'existing' } as CatData] : []);
  await namePartner();
  await clickSave();
  expect(writes).toEqual(['POST /api/cats']);
  expect(saved).toHaveBeenCalledOnce();
});

it('does not infer an empty initial roster while a previously fetched list is refreshing', async () => {
  registry.isLoading = true;
  await render();
  await namePartner();
  await clickSave();
  expect(writes).toEqual(['POST /api/cats']);
  expect(saved).toHaveBeenCalledOnce();
});
