import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { initialState } from '../hub-cat-editor.model';
import { KimiLoginHelp } from '../settings/members/KimiLoginHelp';
import { MemberRuntimeFields } from '../settings/members/MemberRuntimeFields';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
let host: HTMLDivElement, root: Root;
const readiness = {
  status: 'unknown' as const,
  checkedAt: 1,
  loginShell: 'powershell' as const,
  loginCommand: '& { fixture-instance-kimi login }',
};
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  vi.mocked(apiFetch).mockImplementation(
    async (url) =>
      new Response(
        JSON.stringify(
          String(url).startsWith('/api/cats/native-runtimes')
            ? { runtimes: [{ id: 'kimi', label: 'Kimi', clientId: 'kimi', installed: true, models: [], readiness }] }
            : { status: 'configured', models: [] },
        ),
      ),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it.each([
  '',
  'other-account',
])('settings do not warn about unknown Kimi login; recovery stays in configuration details (%s)', async (accountRef) => {
  await act(async () =>
    root.render(
      <MemberRuntimeFields
        form={{ ...initialState(), clientId: 'kimi', configurationSource: 'native_tool', accountRef }}
        accounts={[]}
        patch={() => {}}
        t={(zh) => zh}
        accountHref="/settings?s=accounts"
        editing={false}
      />,
    ),
  );
  expect(host.textContent).not.toContain('Kimi 登录状态尚未验证');
  expect(host.textContent?.includes(readiness.loginCommand)).toBe(accountRef === '');
  if (!accountRef) expect(host.querySelector('details')?.open).toBe(false);
  expect(host.textContent).not.toContain('已检测登录');
});
it('copies the exact installation-bound command without launching anything', async () => {
  const writeText = vi.fn(async () => {});
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  await act(async () => root.render(<KimiLoginHelp readiness={readiness} />));
  const button = host.querySelector('button');
  expect(button?.textContent).toBe('复制登录命令');
  await act(async () => button?.click());
  expect(writeText).toHaveBeenCalledExactlyOnceWith(readiness.loginCommand);
  expect(button?.textContent).toBe('已复制');
});
