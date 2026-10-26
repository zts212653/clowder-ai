import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { apiFetch } from '@/utils/api-client';
import { MemberSettingsPage } from '../settings/members/MemberSettingsPage';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn(), sendMemberSaveDiagnostics: vi.fn(), API_URL: 'isolated' }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams('lang=zh'),
}));
const cat = {
  id: 'dsh-save',
  name: '伙伴',
  displayName: '伙伴',
  clientId: 'anthropic',
  carrier: 'cli',
  defaultModel: '',
  mentionPatterns: ['@伙伴'],
  color: { primary: '#123456', secondary: '#abcdef' },
} as CatData;
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  sessionStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  vi.mocked(apiFetch).mockImplementation(
    async (path) =>
      new Response(
        JSON.stringify(
          path === '/api/session'
            ? { userId: 'dsh-save-owner' }
            : path === '/api/accounts'
              ? { providers: [] }
              : path === '/api/cat-templates'
                ? { templates: [] }
                : path === '/api/cats/native-runtimes'
                  ? {
                      runtimes: [
                        { id: 'claude', label: 'Claude Code', clientId: 'anthropic', installed: true, models: [] },
                        {
                          id: 'dsh',
                          label: 'DSH',
                          clientId: 'acp',
                          installed: true,
                          models: [],
                          discoveryStatus: 'acp_profile_invalid',
                        },
                      ],
                    }
                  : { status: 'unavailable', message: 'acp_profile_invalid', models: [], cats: [], cat },
        ),
      ),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});
async function mount(value = cat) {
  await act(async () =>
    root.render(<MemberSettingsPage cat={value} cats={[value]} onSaved={vi.fn()} onBack={vi.fn()} />),
  );
}
async function button(label: string) {
  const el = [...host.querySelectorAll('button')].find((item) => item.textContent === label);
  if (!el) throw Error(`Button missing: ${label}`);
  await act(async () => el.click());
}
async function choose(value: string) {
  const el = host.querySelector<HTMLSelectElement>('select[aria-label="使用工具"]');
  if (!el) throw Error('Tool selector missing');
  await act(async () => {
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
async function input(label: string, value: string) {
  const el = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (!el) throw Error(`Input missing: ${label}`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const writes = () =>
  vi.mocked(apiFetch).mock.calls.filter(([, init]) => ['PATCH', 'POST'].includes(init?.method ?? ''));
it('cannot select the invalid detected default, including a synthetic change event', async () => {
  await mount();
  expect(host.querySelector<HTMLOptionElement>('option[value=dsh]')?.disabled).toBe(true);
  await choose('dsh');
  expect(host.querySelector<HTMLSelectElement>('select[aria-label="使用工具"]')?.value).toBe('claude');
  expect(host.querySelector('[data-testid=member-save-bar]')?.textContent).toContain('没有改动');
});
it('rejects a legacy invalid ACP/CLI draft before sending a member write', async () => {
  await mount({ ...cat, clientId: 'acp', carrier: 'cli' });
  await button('身份与职责');
  await input('昵称', '新昵称');
  await button('保存');
  expect(writes().filter(([path]) => path === '/api/cats/dsh-save')).toHaveLength(0);
  expect(host.textContent).toContain('请选择 ACP 接入方式');
});
it('keeps manual ACP repair available and saves an explicitly supplied custom descriptor', async () => {
  await mount();
  expect(host.querySelector('option[value="manual:acp"]')).not.toBeNull();
  await choose('manual:acp');
  await button('高级接入');
  await input('启动程序', 'private-dsh');
  await input('启动参数', '--profile repaired --acp');
  await button('保存');
  const write = writes().find(([path]) => path === '/api/cats/dsh-save');
  expect(write).toBeDefined();
  expect(JSON.parse(String(write?.[1]?.body))).toMatchObject({
    clientId: 'acp',
    carrier: 'acp',
    acp: { command: 'private-dsh', startupArgs: ['--profile', 'repaired', '--acp'] },
  });
});
