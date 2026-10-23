import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { useNativeOnboarding } from '../useNativeOnboarding';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ refresh: vi.fn() }) }));

it('consumes the intranet edition in one-click detection and submits only distinct supported identities', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  const templates = ['ragdoll', 'maine-coon'].map((id, index) => ({
    id,
    name: ['布偶猫', '缅因猫'][index],
    nickname: ['宪宪', '砚砚'][index],
    avatar: `/avatars/${id}.png`,
    color: { primary: '#111111', secondary: '#eeeeee' },
    roleDescription: `role-${id}`,
    personality: `personality-${id}`,
  }));
  const runtimes = [
    {
      id: 'codeagent',
      kind: 'tool',
      harnessId: 'codeagent',
      label: 'CodeAgent',
      clientId: 'acp',
      installed: true,
      models: [],
      roleTemplates: templates.map(({ id }) => ({ id, priority: 100 })),
      acp: { command: 'codeagent', startupArgs: ['--acp'] },
    },
    {
      id: 'claude',
      kind: 'tool',
      harnessId: 'claudecode',
      label: 'Claude Code',
      clientId: 'anthropic',
      installed: true,
      models: [],
      readiness: { status: 'configured', checkedAt: 1 },
    },
    { id: 'codex', kind: 'tool', harnessId: 'codex', label: 'Codex', clientId: 'openai', installed: true, models: [] },
    {
      id: 'pi',
      kind: 'tool',
      harnessId: 'pi',
      label: 'Pi',
      clientId: 'acp',
      installed: true,
      models: [],
      acp: { command: 'pi-acp', startupArgs: [] },
    },
  ];
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    let data: object = { status: 'pending' };
    if (String(path).startsWith('/api/cats/native-runtimes')) data = { edition: 'intranet', runtimes };
    if (path === '/api/session') data = { userId: 'intranet-team-confirmation' };
    if (path === '/api/cat-templates') data = { templates };
    if (path === '/api/cats') {
      const payload = init?.method === 'POST' ? JSON.parse(String(init.body)) : undefined;
      data = payload ? { cat: { ...payload, id: payload.catId } } : { cats: [] };
    }
    return new Response(JSON.stringify(data));
  });
  let setup: ReturnType<typeof useNativeOnboarding> | undefined;
  function Harness() {
    setup = useNativeOnboarding(true, vi.fn(), 'members');
    return null;
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Harness />));
    expect(setup?.draft?.partners.map((partner) => partner.form.nickname).sort()).toEqual(['宪宪', '砚砚']);
    await act(async () => setup?.reload());
    await act(async () => setup?.start());
    const bodies = vi
      .mocked(apiFetch)
      .mock.calls.filter(([path, init]) => path === '/api/cats' && init?.method === 'POST')
      .map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies.map((body) => body.nickname).sort()).toEqual(['宪宪', '砚砚']);
    expect(bodies.map((body) => body.clientId).sort()).toEqual(['acp', 'anthropic']);
    expect(bodies.find((body) => body.clientId === 'acp')?.acp).toMatchObject({
      command: 'codeagent',
      startupArgs: ['--acp'],
    });
    expect(vi.mocked(apiFetch).mock.calls.some(([path]) => path === '/api/threads')).toBe(false);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    localStorage.clear();
    vi.resetAllMocks();
    vi.unstubAllGlobals();
  }
});
