import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { apiFetch } from '@/utils/api-client';
import { MemberSettingsPage } from '../settings/members/MemberSettingsPage';

const language = vi.hoisted(() => ({ value: 'zh' }));
vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(),
  sendMemberSaveDiagnostics: vi.fn(async () => new Response(null, { status: 204 })),
  API_URL: 'isolated-agy-settings',
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(`lang=${language.value}`),
}));
const profile = {
  enabled: true,
  carrier: 'native' as const,
  profileId: 'argon-isolated',
  homeRoot: '/isolated/profiles',
  model: 'gemini-4-argon-high',
  autoApprove: false,
  trustedWorkspaces: ['/approved/workspace'],
};
const nativeCat = {
  id: 'gemini-argon',
  displayName: '暹罗猫 Argon',
  avatar: '/avatars/default.png',
  roleDescription: 'isolated fixture',
  personality: '',
  clientId: 'google',
  carrier: 'cli',
  configurationSource: 'native_tool',
  defaultModel: profile.model,
  agyProfile: profile,
  color: { primary: '#123456', secondary: '#abcdef' },
  mentionPatterns: ['@gemini-argon'],
  configurationRevision: 'before',
} as CatData;
let host: HTMLDivElement, root: Root, stored: CatData;
const saved = vi.fn(async () => {});
const writes: Record<string, unknown>[] = [];
let providers: Record<string, unknown>[] = [];
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  sessionStorage.clear();
  language.value = 'zh';
  writes.length = 0;
  providers = [];
  stored = nativeCat;
  saved.mockClear();
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (init?.method === 'PATCH') {
      expect(path).toBe('/api/cats/gemini-argon');
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      writes.push(body);
      stored = { ...stored, ...body, configurationRevision: 'after' } as CatData;
      return Response.json({ cat: stored });
    }
    expect(init?.method ?? 'GET').toBe('GET');
    return Response.json(
      path === '/api/accounts'
        ? { providers, projectPath: '/isolated' }
        : path === '/api/session'
          ? { userId: 'fixture' }
          : path === '/api/cat-templates'
            ? { templates: [] }
            : path === '/api/cats/native-runtimes'
              ? { runtimes: [{ id: 'codex', label: 'Codex', clientId: 'openai', installed: true, models: [] }] }
              : { status: 'configured', models: [], cats: [] },
    );
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
async function render(cat = stored) {
  await act(async () => root.render(<MemberSettingsPage cat={cat} cats={[cat]} onSaved={saved} onBack={() => {}} />));
}
async function click(text: string) {
  const button = [...host.querySelectorAll('button')].find((element) => element.textContent === text);
  expect(button, text).toBeDefined();
  await act(async () => button!.click());
}
async function select(label: string, value: string) {
  const field = host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
  expect(field, label).not.toBeNull();
  expect([...field!.options].map((option) => option.value)).toContain(value);
  await act(async () => {
    field!.value = value;
    field!.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

it('restores the default member page Native → official ACP → saved readback journey', async () => {
  await render();
  expect(host.querySelector('[data-testid="member-identity-summary"]')?.textContent).toContain('AGY Native');
  expect(host.textContent).toContain('隔离 Profile');
  expect(host.querySelector('select[aria-label="使用连接"]')).toBeNull();
  await click('高级接入');
  expect(host.querySelector('select[aria-label="接入方式"]')).toHaveProperty('value', 'agy-native');
  expect(host.querySelector('input[aria-label="隔离 Profile ID"]')).toHaveProperty('value', profile.profileId);
  await select('接入方式', 'agy-acp');
  expect(host.querySelector('[data-testid="member-identity-summary"]')?.textContent).toContain('AGY 官方 ACP');
  expect(host.textContent).toContain('ACP 独立登录');
  expect(host.textContent).toContain('pnpm agy:acp:login --cat gemini-argon');
  expect(host.textContent).toContain('不支持精确插入');
  expect(host.textContent).not.toContain('账号凭据在“账户与密钥”管理');
  expect(host.querySelector('select[aria-label="执行权限"]')).toHaveProperty('value', 'restricted');
  expect(host.querySelector('input[aria-label="启动程序"]')).toBeNull();
  expect(writes).toHaveLength(0);
  await click('保存');
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({
    carrier: 'acp',
    agyProfile: { ...profile, carrier: 'acp' },
    acp: { command: 'agy_acp_server.par', startupArgs: [] },
    expectedRevision: 'before',
  });
  expect(saved).toHaveBeenCalledOnce();
  await act(async () => root.unmount());
  root = createRoot(host);
  await render();
  await click('高级接入');
  expect(host.querySelector('select[aria-label="接入方式"]')).toHaveProperty('value', 'agy-acp');
  expect(host.querySelector('input[aria-label="Profile 根目录"]')).toHaveProperty('value', profile.homeRoot);
  await select('接入方式', 'agy-native');
  await click('保存');
  expect(writes[1]).toMatchObject({ carrier: 'cli', agyProfile: profile, acp: null });
});

it('keeps legacy Google unconfigured until explicit selection and refuses an empty restricted allowlist', async () => {
  stored = { ...nativeCat, agyProfile: undefined };
  await render();
  await click('高级接入');
  expect(host.querySelector('select[aria-label="接入方式"]')).toHaveProperty('value', 'retired');
  expect(host.querySelector('[data-testid="agy-native-settings"]')).toBeNull();
  await select('接入方式', 'agy-acp');
  expect(host.querySelector('select[aria-label="执行权限"]')).toHaveProperty('value', 'restricted');
  await click('保存');
  expect(host.textContent).toContain('至少一个批准工作区');
  expect(writes).toHaveLength(0);
  expect(saved).not.toHaveBeenCalled();
});

it('uses the member page language for profile labels, permissions and independent ACP login guidance', async () => {
  language.value = 'en';
  await render();
  await click('Advanced connection');
  await select('Adapter', 'agy-acp');
  expect(host.textContent).toContain('signed in separately for ACP');
  expect(host.textContent).toContain('Precise insertion into the current generation is unsupported');
  expect(host.querySelector('input[aria-label="Isolated Profile ID"]')).toHaveProperty('value', profile.profileId);
  expect(host.querySelector('select[aria-label="Execution permissions"]')).toHaveProperty('value', 'restricted');
  expect(writes).toHaveLength(0);
});

it('offers the isolated personal identity and disables API-key accounts for AGY', async () => {
  providers = [
    {
      id: 'google-key',
      clientId: 'google',
      authType: 'api_key',
      displayName: 'API fixture',
      baseUrl: 'https://gateway.example.test',
      models: [],
    },
  ];
  await render();
  const connection = host.querySelector<HTMLSelectElement>('select[aria-label="使用连接"]');
  if (!connection) throw new Error('Connection selector missing');
  expect(connection.value).toBe('');
  expect(connection.options[0].textContent).toContain('隔离 Profile 的个人登录');
  expect(connection.querySelector<HTMLOptionElement>('option[value="google-key"]')?.disabled).toBe(true);
  expect(writes).toHaveLength(0);
});

it('returns to the exact AGY profile after switching tools without applying any changes', async () => {
  await render();
  await select('使用工具', 'codex');
  await click('高级接入');
  expect(host.querySelector('[data-testid="agy-native-settings"]')).toBeNull();
  await click('模型与工具');
  const tool = host.querySelector<HTMLSelectElement>('select[aria-label="使用工具"]')!;
  const previous = [...tool.options].find((option) => option.textContent?.includes('已保留的配置'));
  expect(previous).toBeDefined();
  await select('使用工具', previous!.value);
  await click('高级接入');
  expect(host.querySelector('select[aria-label="接入方式"]')).toHaveProperty('value', 'agy-native');
  expect(host.querySelector('input[aria-label="隔离 Profile ID"]')).toHaveProperty('value', profile.profileId);
  expect(host.querySelector('[data-testid="member-save-bar"]')).toBeNull();
  expect(writes).toHaveLength(0);
});
