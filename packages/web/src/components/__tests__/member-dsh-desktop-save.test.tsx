import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { useMemberModelCatalogs } from '@/lib/member-model-display';
import { apiFetch } from '@/utils/api-client';
import { MemberSettingsPage } from '../settings/members/MemberSettingsPage';

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('lang=zh') }));
vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn(), API_URL: 'isolated-desktop-save' }));
vi.mock('../members/MemberCurrentStatus', () => ({ MemberCurrentStatus: () => null }));

it.each([
  'connect',
  'check-failed',
  'prepare-failed',
  'metadata',
])('automatically saves Desktop configuration through the %s path', async (mode) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  sessionStorage.clear();
  useMemberModelCatalogs.setState(useMemberModelCatalogs.getInitialState());
  const cat = {
    id: 'dsh-desktop-save',
    name: 'Whale',
    displayName: 'Whale',
    clientId: 'acp',
    carrier: 'acp',
    configurationSource: 'native_tool',
    defaultModel: '',
    mentionPatterns: ['@whale'],
    color: { primary: '#123456', secondary: '#abcdef' },
    acp: {
      command: mode === 'metadata' ? '/desktop/dsh.cmd' : '/old/agent.cmd',
      startupArgs: ['--profile', 'acp'],
      transport: 'stdio',
    },
  } as CatData;
  const runtime = {
    id: 'dsh',
    label: 'DSH Desktop',
    clientId: 'acp',
    installed: true,
    dshDesktop: true,
    dshSetupSupported: true,
    models: [],
    acp: { command: '/desktop/dsh.cmd', startupArgs: ['--profile', 'acp'], transport: 'stdio' },
  };
  let savedPayload: Record<string, unknown> | undefined;
  const onSaved = vi.fn();
  const order: string[] = [];
  vi.mocked(apiFetch).mockImplementation(async (url, request) => {
    if (url === `/api/cats/${cat.id}` && request?.method === 'PATCH') {
      savedPayload = JSON.parse(String(request.body));
      order.push('saved');
      return Response.json({ cat: { ...cat, ...savedPayload } });
    }
    if (url.startsWith('/api/cats/native-runtimes')) return Response.json({ runtimes: [runtime] });
    if (url.endsWith('/inspect'))
      return Response.json({
        revision: 'a'.repeat(64),
        provider: 'custom',
        model: 'flash',
        providers: [{ id: 'custom', credential: 'configured', models: [{ id: 'flash', label: 'Flash' }] }],
      });
    if (url.endsWith('/prepare'))
      if (mode === 'prepare-failed') return Response.json({ error: 'dsh_setup_credential_missing' }, { status: 422 });
      else
        return Response.json({
          id: 'receipt',
          command: runtime.acp.command,
          startupArgs: ['--profile', 'acp', '--patch', '/host/member.yml'],
          env: { DSH_HOME: '/host/private-home' },
          provider: 'custom',
          model: 'flash',
        });
    if (url.endsWith('/connection-check')) {
      if (request?.method === 'POST') order.push('checked');
      if (request?.method === 'POST' && mode === 'check-failed') return new Promise<Response>(() => {});
      return Response.json({
        state: request?.method === 'POST' ? (mode === 'check-failed' ? 'failed' : 'passed') : 'unchecked',
      });
    }
    if (url === '/api/accounts') return Response.json({ providers: [], projectPath: '/fixture' });
    if (url === '/api/session') return Response.json({ userId: 'fixture' });
    if (url === '/api/cat-templates') return Response.json({ templates: [] });
    if (url === '/api/agent-providers') return Response.json({ libraries: [] });
    return Response.json({ cats: [], status: 'unavailable', models: [] });
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const click = async (name: string) => {
    const button = [...host.querySelectorAll('button')].find((item) => item.textContent === name);
    expect(button, name).toBeDefined();
    await act(async () => button?.click());
  };
  try {
    await act(async () =>
      root.render(<MemberSettingsPage cat={cat} cats={[cat]} onBack={vi.fn()} onSaved={onSaved} />),
    );
    if (mode === 'metadata') {
      await click('身份与职责');
      const input = [...host.querySelectorAll('input')].find((input) => input.value === 'Whale')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'Renamed Whale');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    } else {
      const selector = host.querySelector<HTMLSelectElement>('select[aria-label="使用工具"]')!;
      await act(async () => {
        selector.value = 'dsh';
        selector.dispatchEvent(new Event('change', { bubbles: true }));
      });
      expect(host.textContent).not.toContain('验证并使用此模型');
      expect(host.textContent).not.toContain('读取 Desktop 配置');
    }
    await click('保存');
    if (mode === 'prepare-failed') {
      expect(savedPayload).toBeUndefined();
      expect(onSaved).not.toHaveBeenCalled();
    } else if (mode !== 'metadata') {
      expect(onSaved).toHaveBeenCalledOnce();
      expect(savedPayload).toMatchObject({
        defaultModel: '["custom","flash"]',
        env: { DSH_HOME: '/host/private-home' },
        acp: { command: runtime.acp.command, startupArgs: ['--profile', 'acp', '--patch', '/host/member.yml'] },
      });
      expect(order).toEqual(['saved']);
    } else {
      expect(savedPayload).toMatchObject({ displayName: 'Renamed Whale' });
      expect(savedPayload?.acp).toBeUndefined();
      expect(savedPayload?.env).toBeUndefined();
      expect(vi.mocked(apiFetch).mock.calls.some(([url]) => url.endsWith('/prepare'))).toBe(false);
      expect(order).toEqual(['saved']);
    }
    expect(vi.mocked(apiFetch).mock.calls.some(([url]) => url.endsWith('/test'))).toBe(false);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    sessionStorage.clear();
    useMemberModelCatalogs.setState(useMemberModelCatalogs.getInitialState());
    vi.resetAllMocks();
    vi.unstubAllGlobals();
  }
});
