import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { useMemberModelCatalogs } from '@/lib/member-model-display';
import { apiFetch } from '@/utils/api-client';
import { MemberRuntimeSummary } from '../members/MemberRuntimeSummary';
import { MemberSettingsPage } from '../settings/members/MemberSettingsPage';

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('lang=zh') }));
vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn(), API_URL: 'isolated-dsh-display' }));
vi.mock('../members/MemberCurrentStatus', () => ({ MemberCurrentStatus: () => null }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it.each([
  ['reopen', '/install/node_modules/@deepseek-ai/dsh/lib/bin.js'],
  ['reopen', '/some/install/dsh/lib/bin.js'],
  ['transport', '/install/node_modules/@deepseek-ai/dsh/lib/bin.js'],
  ['transport', '/some/install/dsh/lib/bin.js'],
] as const)('preserves verified descriptor boundaries through settings: %s %s', async (scenario, entry) => {
  sessionStorage.clear();
  useMemberModelCatalogs.setState(useMemberModelCatalogs.getInitialState());
  let failDiscovery = false;
  let removedRuntime = false;
  const acp = {
    command: 'node',
    startupArgs: [entry, '--profile', 'acp'],
    transport: 'stdio' as const,
  };
  const route = '["provider","flash"]';
  const cat = {
    id: 'dsh-display',
    name: 'DSH display',
    displayName: 'DSH display',
    clientId: 'acp',
    carrier: 'acp',
    configurationSource: 'native_tool',
    defaultModel: '',
    mentionPatterns: ['@audit'],
    color: { primary: '#123456', secondary: '#abcdef' },
    acp,
  } as CatData;
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    if (url.startsWith('/api/cats/native-runtimes'))
      return failDiscovery
        ? new Response('{}', { status: 503 })
        : new Response(
            JSON.stringify({
              runtimes: removedRuntime
                ? []
                : [
                    {
                      id: `acp:${cat.id}`,
                      label: 'DSH',
                      clientId: 'acp',
                      installed: true,
                      discoveryStatus: 'configured',
                      dshSetupSupported: true,
                      models: [],
                      acp,
                    },
                  ],
            }),
          );
    switch (url) {
      case '/api/accounts':
        return Response.json({ providers: [], projectPath: '/isolated-dsh-display' });
      case '/api/session':
        return Response.json({ userId: 'isolated-display-user' });
      case '/api/cat-templates':
        return Response.json({ templates: [] });
      case '/api/agent-providers':
        return Response.json({ libraries: [] });
      case '/api/config/session-strategy':
        return Response.json({ cats: [] });
      default:
        return Response.json({
          status: 'live',
          defaultModel: route,
          models: [{ value: route, label: 'DeepSeek Flash' }],
        });
    }
  });
  const host = document.createElement('div');
  let root = createRoot(host);
  const editor = (
    <>
      <MemberSettingsPage cat={cat} cats={[cat]} onSaved={vi.fn()} onBack={vi.fn()} />
      <div data-testid="shared-summary">
        <MemberRuntimeSummary cat={cat} />
      </div>
    </>
  );
  try {
    await act(async () => root.render(editor));
    expect(host.querySelector('[role=combobox]')?.textContent).toContain('DeepSeek Flash · 跟随 DSH 设置');
    expect(host.querySelector<HTMLSelectElement>('select[aria-label="使用工具"]')?.value).toBe('dsh');
    if (scenario === 'reopen') {
      await act(async () => root.unmount());
      failDiscovery = true;
      root = createRoot(host);
      await act(async () => root.render(editor));
      expect(host.querySelector('[role=combobox]')?.textContent).toContain('DeepSeek Flash · 跟随 DSH 设置');
      expect(host.querySelector('[data-testid=shared-summary]')?.textContent).toContain('DSH · DeepSeek Flash');
      expect(host.querySelector('[data-testid=member-identity-summary]')?.textContent).toBe('DSH');
      expect(host.querySelector('[role=alert]')?.textContent).toContain('工具列表读取失败');
      expect(host.querySelector<HTMLSelectElement>('select[aria-label="使用工具"]')?.value).toBe('dsh');
      if (entry === '/some/install/dsh/lib/bin.js') {
        failDiscovery = false;
        removedRuntime = true;
        const refresh = [...host.querySelectorAll('button')].find((button) => button.textContent === '刷新');
        expect(refresh).toBeDefined();
        await act(async () => refresh?.click());
        expect(host.querySelector('[data-testid=member-identity-summary]')?.textContent).toBe('ACP');
        expect(host.textContent).not.toContain('复用 DSH Desktop');
      }
    } else {
      const advanced = [...host.querySelectorAll('button')].find((button) => button.textContent === '高级接入');
      await act(async () => advanced?.click());
      const label = [...host.querySelectorAll('label')].find((item) => item.textContent?.startsWith('传输'));
      const transport = label?.querySelector('select');
      expect(transport).toBeDefined();
      await act(async () => {
        if (transport) transport.value = 'httpstream';
        transport?.dispatchEvent(new Event('change', { bubbles: true }));
      });
      const runtime = [...host.querySelectorAll('button')].find((button) => button.textContent === '模型与工具');
      await act(async () => runtime?.click());
      expect(host.querySelector('[data-testid=member-identity-summary]')?.textContent).toBe('ACP');
      expect(host.textContent).not.toContain('复用 DSH Desktop');
      expect(host.querySelector('[role=combobox]')?.textContent).not.toContain('DeepSeek Flash');
      const discard = [...host.querySelectorAll('button')].find((button) => button.textContent === '放弃修改');
      expect(discard).toBeDefined();
      await act(async () => discard?.click());
      expect(host.querySelector('[data-testid=member-identity-summary]')?.textContent).toBe('DSH');
      expect(host.querySelector('[role=combobox]')?.textContent).toContain('DeepSeek Flash');
      expect(host.querySelector<HTMLSelectElement>('select[aria-label="使用工具"]')?.value).toBe('dsh');
    }
    expect(vi.mocked(apiFetch).mock.calls.some(([, request]) => request?.method === 'PATCH')).toBe(false);
  } finally {
    await act(async () => root.unmount());
    sessionStorage.clear();
    useMemberModelCatalogs.setState(useMemberModelCatalogs.getInitialState());
    vi.resetAllMocks();
  }
});
