import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { apiFetch } from '@/utils/api-client';
import { DefaultCatSelector } from '../DefaultCatSelector';
import { HubMemberOverviewCard } from '../HubMemberOverviewCard';
import { MemberSettingsPage } from '../settings/members/MemberSettingsPage';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(),
  sendMemberSaveDiagnostics: vi.fn(async () => new Response(null, { status: 204 })),
  API_URL: 'isolated-name-test',
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams('lang=zh'),
}));

const original = {
  id: 'opus-5',
  name: 'legacy-internal-name',
  displayName: '布偶猫 Opus',
  variantLabel: '5.5',
  breedId: 'ragdoll',
  breedDisplayName: '布偶猫',
  nickname: '宪宪',
  clientId: 'anthropic',
  configurationSource: 'native_tool',
  defaultModel: '',
  mentionPatterns: ['@opus'],
  color: { primary: '#123456', secondary: '#abcdef' },
} as CatData;
const sibling = { ...original, id: 'sonnet-5', displayName: '布偶猫 Sonnet', variantLabel: '5' };
let cat: CatData, host: HTMLDivElement, root: Root;
const saved = vi.fn<(cat: CatData) => Promise<void>>().mockResolvedValue(undefined);

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  sessionStorage.clear();
  saved.mockClear();
  cat = { ...original };
  vi.mocked(apiFetch).mockReset();
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path === '/api/cats/opus-5' && init?.method === 'PATCH') {
      cat = { ...cat, ...JSON.parse(String(init.body)) };
      return new Response(JSON.stringify({ cat }));
    }
    const body =
      path === '/api/accounts'
        ? { providers: [], projectPath: '/isolated-name-test' }
        : path === '/api/session'
          ? { userId: 'test' }
          : path === '/api/cat-templates'
            ? { templates: [] }
            : path === '/api/cats/native-runtimes'
              ? { runtimes: [] }
              : { cats: [] };
    return new Response(JSON.stringify(body));
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function overview() {
  await act(async () =>
    root.render(
      <>
        <HubMemberOverviewCard cat={cat} />
        <HubMemberOverviewCard cat={sibling} />
        <DefaultCatSelector cats={[cat, sibling]} currentDefaultCatId={cat.id} onSelect={() => {}} />
      </>,
    ),
  );
}
async function editor() {
  await act(async () =>
    root.render(<MemberSettingsPage cat={cat} cats={[cat, sibling]} onSaved={saved} onBack={() => {}} />),
  );
  await click('身份与职责');
}
async function click(text: string) {
  const button = [...host.querySelectorAll('button')].find((item) => item.textContent === text);
  expect(button, text).toBeDefined();
  await act(async () => button?.click());
}
function field(label: string) {
  const input = [...host.querySelectorAll('label')].find((item) => item.textContent === label)?.querySelector('input');
  expect(input, label).toBeTruthy();
  return input!;
}
async function fill(label: string, value: string) {
  await act(async () => {
    const input = field(label);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

it('uses the configured display name consistently in cards, selectors and the editable detail', async () => {
  await overview();
  expect(host.querySelector('[data-testid=cat-card-opus-5]')?.textContent).toContain('布偶猫 Opus（5.5）');
  expect(host.querySelector('[data-testid=cat-card-sonnet-5]')?.textContent).toContain('布偶猫 Sonnet（5）');
  expect(host.querySelector('option[value=opus-5]')?.textContent).toBe('布偶猫 Opus（5.5） · 宪宪');
  await editor();
  expect(host.querySelector('h1')?.textContent).toBe('布偶猫 Opus（5.5） · 宪宪');
  expect(field('名字').value).toBe('布偶猫 Opus');
  expect(host.querySelector('[data-testid=member-save-bar]')).toBeNull();
});

it('shows a saved rename after returning to the list without changing the sibling or routing identity', async () => {
  await editor();
  await fill('名字', '架构伙伴');
  await click('保存');
  expect(saved.mock.calls.at(-1)?.[0]).toEqual(cat);
  expect(host.querySelector('h1')?.textContent).toBe('架构伙伴（5.5） · 宪宪');
  expect(field('名字').value).toBe('架构伙伴');
  expect(host.querySelector('[data-testid=member-save-bar]')).toBeNull();
  expect(cat.displayName).toBe('架构伙伴');
  expect(cat.mentionPatterns).toEqual(['@opus']);
  expect(cat.breedDisplayName).toBe('布偶猫');
  await overview();
  expect(host.querySelector('[data-testid=cat-card-opus-5]')?.textContent).toContain('架构伙伴（5.5）');
  expect(host.querySelector('option[value=opus-5]')?.textContent).toBe('架构伙伴（5.5） · 宪宪');
  expect(host.querySelector('[data-testid=cat-card-sonnet-5]')?.textContent).toContain('布偶猫 Sonnet（5）');
  await editor();
  expect(host.querySelector('h1')?.textContent).toBe('架构伙伴（5.5） · 宪宪');
});

it('keeps nickname edits secondary and clearing the nickname removes it without changing the name', async () => {
  await editor();
  await fill('昵称', '新昵称');
  await click('保存');
  expect(saved.mock.calls.at(-1)?.[0]).toEqual(cat);
  expect(host.querySelector('h1')?.textContent).toBe('布偶猫 Opus（5.5） · 新昵称');
  expect(field('昵称').value).toBe('新昵称');
  expect(host.querySelector('[data-testid=member-save-bar]')).toBeNull();
  expect(cat.name).toBe('legacy-internal-name');
  expect(cat.displayName).toBe(original.displayName);
  await overview();
  const card = host.querySelector('[data-testid=cat-card-opus-5]');
  expect(card?.textContent).toContain('布偶猫 Opus（5.5）');
  expect(card?.textContent).toContain('昵称：新昵称');
  expect(host.querySelector('option[value=opus-5]')?.textContent).toBe('布偶猫 Opus（5.5） · 新昵称');
  await editor();
  await fill('昵称', '');
  await click('保存');
  await overview();
  expect(host.querySelector('[data-testid=cat-card-opus-5]')?.textContent).not.toContain('昵称：');
  expect(host.querySelector('option[value=opus-5]')?.textContent).toBe('布偶猫 Opus（5.5）');
});
