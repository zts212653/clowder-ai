import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { initialState } from '../../hub-cat-editor.model';
import { MemberRuntimeFields } from '../../settings/members/MemberRuntimeFields';
import { type RuntimeChoice, runtimeDefaults } from '../../settings/members/member-runtime-draft';
import { NativePartnerCard } from '../NativePartnerCard';
import { nativeRuntimeSelectable, recommendNativePartners } from '../native-onboarding';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});
function runtime(invalid: boolean): RuntimeChoice {
  return {
    id: 'dsh',
    label: 'DSH',
    clientId: 'acp',
    installed: true,
    models: [],
    discoveryStatus: invalid ? 'acp_profile_invalid' : 'acp_profile_missing',
    ...(!invalid ? { acp: { command: 'dsh', startupArgs: ['--profile', 'acp'], transport: 'stdio' as const } } : {}),
  };
}
it.each([
  false,
  true,
])('distinguishes first connection from existing invalid DSH configuration (invalid=%s)', async (invalid) => {
  const peer = runtime(invalid);
  const partner = recommendNativePartners([peer], [], [], 'dsh-status')[0];
  const patch = vi.fn();
  await act(async () =>
    root.render(<NativePartnerCard partner={partner} created={false} patch={patch} onValidityChange={vi.fn()} />),
  );
  const checkbox = host.querySelector<HTMLInputElement>('input[type=checkbox]');
  if (!checkbox) throw new Error('Partner checkbox missing');
  expect(checkbox.disabled).toBe(invalid);
  expect(partner.selected).toBe(!invalid);
  expect(nativeRuntimeSelectable(peer, partner.form)).toBe(!invalid);
  expect(host.textContent).toContain(invalid ? '已安装 · ACP 配置异常' : '已安装 · 首次连接初始化 ACP');
  expect(host.textContent).not.toContain('未检测到');
  expect(host.textContent).not.toContain('需要已安装的 DSH');
  if (invalid) {
    expect(host.textContent).toContain('修复现有 ACP 配置');
    expect(host.textContent).toContain('不会自动覆盖');
  } else {
    expect(host.textContent).toContain('浏览和创建伙伴不会初始化');
    expect(host.textContent).toContain('实际连接时由 DSH 准备');
    await act(async () => checkbox.click());
    expect(patch).toHaveBeenCalledWith({ selected: false });
  }
  expect(apiFetch).not.toHaveBeenCalled();
});
it.each([
  { invalid: false, nativeSetup: false },
  { invalid: true, nativeSetup: false },
  { invalid: false, nativeSetup: true },
  { invalid: true, nativeSetup: true },
])('preserves DSH settings and scopes discovery (invalid=$invalid, nativeSetup=$nativeSetup)', async ({
  invalid,
  nativeSetup,
}) => {
  const peer = runtime(invalid);
  vi.mocked(apiFetch).mockImplementation(
    async (path) =>
      new Response(
        JSON.stringify(
          path === '/api/agent-providers'
            ? { libraries: [] }
            : path === '/api/cats/native-runtimes'
              ? { runtimes: [peer] }
              : {
                  status: invalid ? 'unavailable' : 'configured',
                  models: [],
                  message: invalid ? 'acp_profile_invalid' : 'acp_profile_missing',
                },
        ),
      ),
  );
  const patch = vi.fn();
  const validity = vi.fn();
  await act(async () =>
    root.render(
      <MemberRuntimeFields
        nativeSetup={nativeSetup}
        form={{ ...initialState(), ...runtimeDefaults(peer) }}
        accounts={[]}
        patch={patch}
        t={(zh) => zh}
        accountHref="/settings?s=members"
        editing={false}
        onValidityChange={validity}
      />,
    ),
  );
  if (nativeSetup) expect(host.querySelector('option[value=dsh]')).toBeNull();
  else
    expect(host.querySelector('option[value=dsh]')?.textContent).toContain(
      invalid ? '已安装 · ACP 配置异常' : '已安装 · 首次连接初始化 ACP',
    );
  expect(host.textContent).toContain(invalid ? '修复现有 ACP 配置' : '实际连接时由 DSH 准备');
  expect(host.textContent).toContain(invalid ? '不会自动覆盖' : '浏览和创建伙伴不会初始化');
  expect(host.textContent).not.toContain('已检测登录');
  expect(patch).not.toHaveBeenCalled();
  expect(validity).toHaveBeenLastCalledWith(!invalid);
  expect(new Set(vi.mocked(apiFetch).mock.calls.map(([path]) => path))).toEqual(
    new Set([
      '/api/cats/native-runtimes',
      '/api/cats/runtime-models',
      ...(!nativeSetup ? ['/api/agent-providers'] : []),
    ]),
  );
  expect(
    vi
      .mocked(apiFetch)
      .mock.calls.every(([path, options]) =>
        path === '/api/cats/runtime-models' ? options?.method === 'POST' : !options?.method || options.method === 'GET',
      ),
  ).toBe(true);
});
