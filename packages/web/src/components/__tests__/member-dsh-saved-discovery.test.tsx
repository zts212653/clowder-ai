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
] as const)('publishes only a confirmed exact prepared descriptor: %s', async (result) => {
  sessionStorage.clear();
  useMemberModelCatalogs.setState(useMemberModelCatalogs.getInitialState());
  const acp = {
    command: 'node',
    startupArgs: ['/install/dsh/lib/bin.js', '--profile', 'acp'],
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
    acp,
    color: { primary: '#123456', secondary: '#abcdef' },
  } as CatData;
  let saved: CatData | undefined;
  let failDiscovery = false;
  let removed = false;
  let writes = 0;
  let pendingDiscovery: Promise<Response> | undefined;
  let finishDiscovery: ((response: Response) => void) | undefined;
  const runtime = {
    id: 'acp:source',
    label: 'DSH',
    clientId: 'acp',
    installed: true,
    discoveryStatus: 'configured',
    dshSetupSupported: true,
    models: [],
    acp,
  };
  vi.mocked(apiFetch).mockImplementation(async (url, request) => {
    if (url === '/api/cats/saved-dsh' && request?.method === 'PATCH') {
      writes++;
      if (result === 'rejected') return Response.json({ error: 'save rejected' }, { status: 400 });
      const member: CatData = { ...cat, ...(JSON.parse(String(request.body)) as Partial<CatData>) };
      if (result === 'different') member.acp = { ...acp, ...member.acp, startupArgs: [...generated, '--manual'] };
      return Response.json({ cat: member });
    }
    if (url.startsWith('/api/cats/native-runtimes'))
      return (
        pendingDiscovery ??
        (failDiscovery
          ? Response.json({}, { status: 503 })
          : Response.json({
              runtimes: removed ? [] : [runtime],
            }))
      );
    if (url.endsWith('/inspect'))
      return Response.json({
        profiles: ['acp'],
        sourceProfile: 'acp',
        revision: 'a'.repeat(64),
        active: { providers: [] },
        source: { providers: [{ id: 'fixture', models: [{ id: 'flash', label: 'Flash' }] }] },
      });
    if (url.endsWith('/prepare')) return Response.json({ id: 'receipt', command: 'node', startupArgs: generated });
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
    await click('读取 DSH 配置');
    await click('使用此配置');
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
    const preparedCat = { ...cat, acp: { ...acp, startupArgs: generated } };
    await act(async () => root.render(<MemberRuntimeSummary cat={saved ?? preparedCat} />));
    if (result === 'rejected' || result === 'different') {
      expect(host.textContent).toContain('ACP Client');
      expect(host.textContent).not.toContain('DeepSeek Flash');
      return;
    }
    expect(saved?.acp?.startupArgs).toEqual(generated);
    expect(saved?.defaultModel).toBe('');
    expect(host.textContent).toContain('DSH · DeepSeek Flash');
    // Saving another descriptor must preserve the original discovered tool too.
    expect(useMemberModelCatalogs.getState().runtimes.some((item) => item.id === 'acp:source')).toBe(true);
    for (const changed of [
      { ...saved, agentProvider: 'plugin:fixture/tool' },
      { ...saved, acp: { ...saved?.acp, transport: 'httpstream' } },
      { ...saved, acp: { ...saved?.acp, startupArgs: [...generated, '--manual'] } },
    ]) {
      await act(async () => root.render(<MemberRuntimeSummary cat={changed as CatData} />));
      expect(host.textContent).not.toContain('DSH · DeepSeek Flash');
    }
    failDiscovery = true;
    await act(async () => root.render(editor(saved as CatData)));
    expect(host.querySelector('[data-testid=member-identity-summary]')?.textContent).toBe('DSH');
    expect(host.querySelector('[role=alert]')?.textContent).toContain('工具列表读取失败');
    failDiscovery = false;
    removed = true;
    await click('刷新');
    expect(host.querySelector('[data-testid=member-identity-summary]')?.textContent).toBe('ACP');
    await act(async () => root.render(<MemberRuntimeSummary cat={saved as CatData} />));
    expect(host.textContent).toContain('ACP Client');
    expect(writes).toBe(1);
  } finally {
    await act(async () => root.unmount());
    sessionStorage.clear();
    useMemberModelCatalogs.setState(useMemberModelCatalogs.getInitialState());
    vi.resetAllMocks();
  }
});
