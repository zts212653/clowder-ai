import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { HubAccountsTab } from '../HubAccountsTab';
import { writeShellLanguage } from '../shell/shell-language';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ cats: [] }) }));
vi.mock('../useConfirm', () => ({ useConfirm: () => async () => true }));
const native = {
  id: 'codex',
  name: 'Codex',
  displayName: 'Codex App 登录（本机默认）',
  builtin: true,
  authType: 'oauth',
  clientId: 'openai',
  hasApiKey: false,
  codexLoginStatus: 'ready',
};
const backup = {
  ...native,
  id: 'backup',
  builtin: false,
  displayName: '私人备注',
  codex: { status: 'ready', identity: { userId: 'u', workspaceId: 'w', email: 'fixture@example.test' } },
};
const selected = () => Response.json({ selection: { state: 'selected', accountRef: 'codex', members: [] } });
const list = (extra = {}) => Response.json({ projectPath: '/fixture', providers: [native, backup], ...extra });
let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  writeShellLanguage('zh');
  vi.mocked(apiFetch).mockReset();
  vi.mocked(apiFetch).mockImplementation(async (path) => (String(path).endsWith('/members') ? selected() : list()));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  writeShellLanguage('zh');
  vi.unstubAllGlobals();
});
const render = () => act(async () => root.render(<HubAccountsTab />));
const refresh = () =>
  act(async () => {
    window.dispatchEvent(new Event('accounts-changed'));
  });
async function click(label: string) {
  await act(async () => {
    const button = [...document.querySelectorAll('button')].find((b) => b.textContent === label);
    expect(button, label).toBeTruthy();
    button!.click();
  });
}
it('native enumeration failure does not negate a successfully read selected account', async () => {
  vi.mocked(apiFetch).mockImplementation(async (path) =>
    String(path).endsWith('/members')
      ? selected()
      : list({ nativeDefaultsError: '运行成员信息读不到，本机默认账号列表未能补全' }),
  );
  await render();
  expect(host.querySelector('[data-account-id="codex"]')?.textContent).toContain('正在用');
  expect(host.textContent).toContain('本机默认账号列表未能补全');
  expect(host.textContent).not.toContain('正在用的账号暂不能确认');
});
it.each([
  'http',
  'throw',
  'missing',
])('selection %s failure clears the old selected claim and successful retry restores it', async (mode) => {
  await render();
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    if (!String(path).endsWith('/members')) return list();
    if (mode === 'throw') throw new Error('offline');
    return mode === 'http' ? Response.json({}, { status: 503 }) : Response.json({});
  });
  await refresh();
  expect(host.querySelector('.account-used')).toBeNull();
  expect(host.textContent).toContain('正在用的账号暂不能确认');
  vi.mocked(apiFetch).mockImplementation(async (path) => (String(path).endsWith('/members') ? selected() : list()));
  await click('重试读取');
  expect(host.querySelector('.account-used')).not.toBeNull();
  expect(host.textContent).not.toContain('正在用的账号暂不能确认');
});
it('an older selection success cannot restore a claim after a newer selection failure', async () => {
  let finish!: (response: Response) => void;
  vi.mocked(apiFetch).mockImplementation(async (path) =>
    String(path).endsWith('/members')
      ? new Promise<Response>((r) => {
          finish = r;
        })
      : list(),
  );
  await render();
  vi.mocked(apiFetch).mockImplementation(async (path) =>
    String(path).endsWith('/members') ? Response.json({}, { status: 503 }) : list(),
  );
  await refresh();
  await act(async () => finish(selected()));
  expect(host.querySelector('.account-used')).toBeNull();
  expect(host.textContent).toContain('正在用的账号暂不能确认');
});
it('English covers the directory, native product name, expanded details and add form while preserving notes and form input', async () => {
  writeShellLanguage('en');
  await render();
  expect(host.textContent).toContain('Codex App login (local default)');
  expect(host.textContent).toContain('In use');
  expect(host.textContent).toContain('私人备注');
  await click('私人备注');
  expect(host.querySelector('thead')?.textContent).toContain('Quota');
  expect(host.querySelector('.account-expanded')?.textContent).not.toContain('Check quota');
  expect(host.textContent).toContain('Login details');
  await click('+ Add account');
  await click('Codex · Sign in to another account');
  const input = document.querySelector<HTMLInputElement>('input[aria-label="Account note"]')!;
  expect(input).toBeTruthy();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '我的公司');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(document.body.textContent).toContain('Create and start login');
  await act(async () => writeShellLanguage('zh'));
  expect(input.value).toBe('我的公司');
  expect(document.body.textContent).toContain('创建并开始登录');
  await act(async () => writeShellLanguage('en'));
  expect(input.value).toBe('我的公司');
  expect(document.body.textContent).toContain('Adding an account does not change member bindings');
});
it('English switch confirmation and known login errors remain actionable without changing bindings', async () => {
  writeShellLanguage('en');
  vi.mocked(apiFetch).mockImplementation(async (path, init) =>
    init?.method === 'POST'
      ? Response.json({ error: '本机默认号未登录或读不到，请先在官方工具里登录' }, { status: 409 })
      : String(path).endsWith('/members')
        ? selected()
        : list(),
  );
  await render();
  await click('Use account');
  expect(host.querySelector('section[aria-label="Confirm account switch"]')).not.toBeNull();
  expect(host.textContent).toContain('Sign in using the official tool');
  expect(vi.mocked(apiFetch).mock.calls.some(([p]) => String(p).endsWith('/binding/commit'))).toBe(false);
});

it('English creation with a blank note sends a localized product name without changing user-provided notes', async () => {
  writeShellLanguage('en');
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (init?.method === 'POST' && path === '/api/accounts') return Response.json({ profile: backup });
    if (init?.method === 'POST') return Response.json({ codex: backup.codex });
    return String(path).endsWith('/members') ? selected() : list();
  });
  await render();
  await click('+ Add account');
  await click('Codex · Sign in to another account');
  await click('Create and start login');
  const request = vi
    .mocked(apiFetch)
    .mock.calls.find(([path, init]) => path === '/api/accounts' && init?.method === 'POST');
  expect(JSON.parse(String(request?.[1]?.body)).displayName).toBe('Codex account');
});

it('English switch preview uses one member for both the target and exception', async () => {
  writeShellLanguage('en');
  vi.mocked(apiFetch).mockImplementation(async (path, init) =>
    init?.method === 'POST'
      ? Response.json({
          previewToken: 'fixture',
          accountRef: 'backup',
          targets: [{ catId: 'sol', name: 'Sol', previousAccountRef: 'codex' }],
          exceptions: [{ catId: 'astra', name: 'Astra', previousAccountRef: 'other', previousAccountName: '用户备注' }],
        })
      : String(path).endsWith('/members')
        ? selected()
        : list(),
  );
  await render();
  await click('Use account');
  expect(host.textContent).toContain('1 member will switch:');
  expect(host.textContent).toContain('1 member on other accounts: Astra（用户备注）');
  expect(host.textContent).not.toContain('1 members');
});
it.each([
  ['Identity required (session cookie or X-Cat-Cafe-User header)', '需要登录身份'],
  ['Invalid project path: must be an existing directory under allowed roots', '项目路径无效'],
  ['Account "stale" not found', '找不到账号「stale」'],
])('Chinese account list displays the known route error %s in Chinese', async (error, expected) => {
  vi.mocked(apiFetch).mockImplementation(async (path) =>
    String(path).endsWith('/members') ? selected() : Response.json({ error }, { status: 400 }),
  );
  await render();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(expected);
  expect(host.querySelector('[role="alert"]')?.textContent).not.toContain(error);
  expect(host.textContent).toContain('重试读取');
});

it.each([
  ['Provider base URL must use HTTP(S)', '服务商地址须使用 HTTP(S)'],
  ['account "backup" endpoint URL must not contain userinfo', '账号「backup」的服务商地址不能包含用户名或密码'],
  [
    'bound provider profile "backup" identity is incompatible with openai at official kimi endpoint',
    '绑定账号「backup」的身份与 kimi 官方端点的 openai 协议不兼容',
  ],
])('binding preview displays the localized dependency error %s and preserves it across a locale change', async (error, expected) => {
  vi.mocked(apiFetch).mockImplementation(async (path, init) =>
    init?.method === 'POST'
      ? Response.json({ error }, { status: 409 })
      : String(path).endsWith('/members')
        ? selected()
        : list(),
  );
  await render();
  await click('换成这个');
  const alert = () => host.querySelector('.account-switch-confirm [role="alert"]')?.textContent;
  expect(alert()).toBe(expected);
  await act(async () => writeShellLanguage('en'));
  expect(alert()).toBe(error);
  expect(vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  expect(host.querySelector('.account-used')).not.toBeNull();
});
it('binding commit displays a changed-preview error without changing selection', async () => {
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (String(path).endsWith('/binding/commit'))
      return Response.json({ error: 'Binding preview changed; please review it again' }, { status: 409 });
    if (init?.method === 'POST')
      return Response.json({ previewToken: 'fixture', accountRef: 'backup', targets: [], exceptions: [] });
    return String(path).endsWith('/members') ? selected() : list();
  });
  await render();
  await click('换成这个');
  await click('确认换号');
  expect(host.querySelector('.account-switch-confirm [role="alert"]')?.textContent).toBe(
    '换号影响已变化，请重新预览确认',
  );
  expect(host.querySelector('[data-account-id="codex"] .account-used')).not.toBeNull();
});
it.each([
  [
    'codex_managed_layout_changed',
    '托管账号目录已改变，请核对账号配置',
    'Managed account directories changed. Check the account configuration.',
  ],
  ['codex_managed_layout_invalid', '托管账号目录配置无效', 'The managed account directory configuration is invalid.'],
])('login retry displays the localized preparation failure %s in the account row', async (error, zh, en) => {
  vi.mocked(apiFetch).mockImplementation(async (path, init) =>
    init?.method === 'POST'
      ? Response.json({ error }, { status: 409 })
      : String(path).endsWith('/members')
        ? selected()
        : list({ providers: [native, { ...backup, codex: { ...backup.codex, status: 'not_logged_in' } }] }),
  );
  await render();
  await click('重试');
  const alert = () => host.querySelector('.account-expanded [role="alert"]')?.textContent;
  expect(alert()).toBe(zh);
  await act(async () => writeShellLanguage('en'));
  expect(alert()).toBe(en);
  expect(vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
});
