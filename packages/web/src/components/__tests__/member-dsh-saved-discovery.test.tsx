import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { useMemberModelCatalogs } from '@/lib/member-model-display';
import { apiFetch } from '@/utils/api-client';
import { MemberRuntimeSummary } from '../members/MemberRuntimeSummary';
import { MemberSettingsPage } from '../settings/members/MemberSettingsPage';

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('lang=zh') }));
vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn(), API_URL: 'isolated-saved-dsh' }));
vi.mock('../members/MemberCurrentStatus', () => ({ MemberCurrentStatus: () => null }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it.each([
  'saved',
  'rejected',
  'different',
  'earlier-refresh',
] as const)('keeps saved Desktop bindings separate from discovery metadata: %s', async (result) => {
  sessionStorage.clear();
  useMemberModelCatalogs.setState(useMemberModelCatalogs.getInitialState());
  const acp = {
    command: '/desktop/dsh.cmd',
    startupArgs: ['--profile', 'acp'],
    transport: 'stdio' as const,
  };
  const generated = [...acp.startupArgs, '--patch', '/fixture/provider.yml'];
  const cat = {
    id: 'saved-dsh',
    name: 'Saved DSH',
    displayName: 'Saved DSH',
    clientId: 'acp',
    carrier: 'acp',
    configurationSource: 'native_tool',
    defaultModel: '',
    mentionPatterns: ['@saved-dsh'],
    avatar: '',
    roleDescription: '',
    personality: '',
    acp: { command: '/old/agent.cmd', startupArgs: [], transport: 'stdio' },
    color: { primary: '#123456', secondary: '#abcdef' },
  } satisfies CatData;
  let saved: CatData | undefined;
  let failDiscovery = false;
  let removed = false;
  let writes = 0;
  let pendingDiscovery: Promise<Response> | undefined;
  let finishDiscovery: ((response: Response) => void) | undefined;
  const runtime = {
    id: 'dsh',
    label: 'DSH',
    clientId: 'acp',
    installed: true,
    discoveryStatus: 'configured',
    dshSetupSupported: true,
    dshDesktop: true,
    models: [],
    acp,
  };
  vi.mocked(apiFetch).mockImplementation(async (url, request) => {
    if (url === '/api/cats/saved-dsh' && request?.method === 'PATCH') {
      writes++;
      if (result === 'rejected') return Response.json({ error: 'save rejected' }, { status: 400 });
      const member: CatData = { ...cat, ...(JSON.parse(String(request.body)) as Partial<CatData>) };
      if (result === 'different') member.acp = { command: 'other-acp', startupArgs: ['--opaque'] };
      return Response.json({ cat: member });
    }
    if (url.startsWith('/api/cats/native-runtimes')) {
      if (pendingDiscovery) {
        const pending = pendingDiscovery;
        pendingDiscovery = undefined;
        return pending;
      }
      return failDiscovery
        ? Response.json({}, { status: 503 })
        : Response.json({
            runtimes: removed ? [] : [runtime],
          });
    }
    if (url.endsWith('/inspect'))
      return Response.json({
        revision: 'a'.repeat(64),
        provider: 'fixture',
        model: 'flash',
        providers: [{ id: 'fixture', credential: 'configured', models: [{ id: 'flash', label: 'Flash' }] }],
      });
    if (url.endsWith('/prepare'))
      return Response.json({
        id: 'receipt',
        command: acp.command,
        startupArgs: generated,
        env: { DSH_HOME: '/host/private' },
        provider: 'fixture',
        model: 'flash',
      });
    if (url.endsWith('/connection-check')) return Response.json({ state: 'passed' });
    switch (url) {
      case '/api/accounts':
        return Response.json({ providers: [], projectPath: '/fixture' });
      case '/api/session':
        return Response.json({ userId: 'fixture' });
      case '/api/cat-templates':
        return Response.json({ templates: [] });
      case '/api/agent-providers':
        return Response.json({ libraries: [] });
      case '/api/config/session-strategy':
        return Response.json({ cats: [] });
      default:
        return Response.json({
          status: 'live',
          defaultModel: '["p","flash"]',
          models: [{ value: '["p","flash"]', label: 'DeepSeek Flash' }],
        });
    }
  });
  const host = document.createElement('div');
  const root = createRoot(host);
  const editor = (member: CatData) => (
    <MemberSettingsPage
      cat={member}
      cats={[member]}
      onBack={vi.fn()}
      onSaved={async (value) => {
        saved = value;
      }}
    />
  );
  const click = async (name: string) => {
    const button = [...host.querySelectorAll('button')].find((item) => item.textContent === name);
    expect(button).toBeDefined();
    await act(async () => button?.click());
  };
  try {
    await act(async () => root.render(editor(cat)));
    expect(writes).toBe(0);
    const tool = host.querySelector<HTMLSelectElement>('select[aria-label="使用工具"]')!;
    await act(async () => {
      tool.value = 'dsh';
      tool.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(host.textContent).not.toContain('验证并使用此模型');
    expect(writes).toBe(0);
    if (result === 'earlier-refresh') {
      pendingDiscovery = new Promise((resolve) => {
        finishDiscovery = resolve;
      });
      await click('刷新');
    }
    await click('保存');
    expect(writes).toBe(1);
    if (finishDiscovery) {
      await act(async () => finishDiscovery?.(Response.json({ runtimes: [runtime] })));
      pendingDiscovery = undefined;
      expect(host.querySelector('[data-testid=member-identity-summary]')?.textContent).toBe('DSH');
    }
    await act(async () => root.render(<MemberRuntimeSummary cat={saved ?? cat} />));
    if (result === 'rejected' || result === 'different') {
      expect(host.textContent).toContain('ACP Client');
      expect(host.textContent).not.toContain('DeepSeek Flash');
      return;
    }
    expect(saved?.acp?.startupArgs).toEqual(generated);
    expect(saved?.defaultModel).toBe('["fixture","flash"]');
    expect(saved?.env).toEqual({ DSH_HOME: '/host/private' });
    expect(host.textContent).toContain('DSH · fixture / flash');
    // Saving another descriptor must preserve the original discovered tool too.
    expect(useMemberModelCatalogs.getState().runtimes.some((item) => item.id === 'dsh')).toBe(true);
    for (const changed of [
      { ...saved, agentProvider: 'plugin:fixture/tool' },
      { ...saved, acp: { ...saved?.acp, transport: 'httpstream' } },
      { ...saved, acp: { command: 'other-acp', startupArgs: ['--opaque'] } },
    ]) {
      await act(async () => root.render(<MemberRuntimeSummary cat={changed as CatData} />));
      expect(host.textContent).not.toContain('DSH · fixture / flash');
    }
    failDiscovery = true;
    await act(async () => root.render(editor(saved as CatData)));
    expect(host.querySelector('[data-testid=member-identity-summary]')?.textContent).toBe('DSH');
    expect(host.querySelector('[role=alert]')?.textContent).toContain('工具列表读取失败');
    failDiscovery = false;
    removed = true;
    await click('刷新');
    expect(host.querySelector('[data-testid=member-identity-summary]')?.textContent).toBe('DSH');
    await act(async () => root.render(<MemberRuntimeSummary cat={saved as CatData} />));
    expect(host.textContent).toContain('DSH · fixture / flash');
    expect(writes).toBe(1);
    expect(vi.mocked(apiFetch).mock.calls.some(([path]) => path.endsWith('/test'))).toBe(false);
  } finally {
    await act(async () => root.unmount());
    sessionStorage.clear();
    useMemberModelCatalogs.setState(useMemberModelCatalogs.getInitialState());
    vi.resetAllMocks();
  }
});
