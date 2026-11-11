import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useToastStore } from '@/stores/toastStore';
import { apiFetch } from '@/utils/api-client';
import { useNativeOnboarding } from '../useNativeOnboarding';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ refresh: vi.fn() }) }));
it.each([
  'goal',
  'members',
] as const)('prepares, durably saves, checks, then navigates in %s mode; reopening never bills again', async (mode) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  useToastStore.setState({ toasts: [] });
  const host = document.createElement('div');
  const root = createRoot(host);
  const onCreated = vi.fn();
  let setup!: ReturnType<typeof useNativeOnboarding>;
  function Harness() {
    setup = useNativeOnboarding(true, onCreated, mode);
    return <p>{setup.busy}</p>;
  }
  const runtime = {
    id: 'dsh-desktop',
    label: 'DSH',
    clientId: 'acp',
    installed: true,
    dshDesktop: true,
    models: [],
    acp: { command: '/desktop/dsh.cmd', startupArgs: ['--profile', 'acp'] },
  };
  const writes: Record<string, unknown>[] = [];
  let finish!: (response: Response) => void;
  let entered!: () => void;
  const checking = new Promise<void>((resolve) => {
    entered = resolve;
  });
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path === '/api/session') return Response.json({ userId: 'owner' });
    if (path.startsWith('/api/cats/native-runtimes')) return Response.json({ runtimes: [runtime] });
    if (path === '/api/cat-templates') return Response.json({ templates: [] });
    if (path === '/api/config/onboarding/entry') return Response.json({ status: 'pending' });
    if (path.endsWith('/inspect'))
      return Response.json({
        revision: 'r',
        provider: 'custom',
        model: 'chosen',
        providers: [{ id: 'custom', credential: 'configured', models: [{ id: 'chosen', label: 'Chosen' }] }],
      });
    if (path.endsWith('/prepare'))
      return Response.json({
        command: runtime.acp.command,
        startupArgs: ['--profile', 'acp', '--patch', '/private/member.yml'],
        env: { DSH_HOME: '/private/home' },
        provider: 'custom',
        model: 'chosen',
      });
    if (path === '/api/cats') {
      if (!init?.method)
        return Response.json({
          cats: writes.map((body) => ({
            ...body,
            id: body.catId,
            configurationRevision: 'saved',
            color: { primary: '#123456', secondary: '#abcdef' },
          })),
        });
      const body = JSON.parse(String(init.body));
      writes.push(body);
      return Response.json({ cat: { ...body, id: body.catId, configurationRevision: 'saved' } });
    }
    if (path.endsWith('/connection-check')) {
      expect(writes).toHaveLength(1);
      const stored = Array.from({ length: localStorage.length }, (_, index) =>
        JSON.parse(localStorage.getItem(localStorage.key(index)!)!),
      ).find((value) => value.created);
      expect(Object.keys(stored.created)).toHaveLength(1);
      entered();
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    }
    if (path === '/api/threads') return Response.json({ id: 'thread' });
    throw Error(`Unexpected ${path}`);
  });
  try {
    await act(async () => root.render(<Harness />));
    expect(setup.draft?.partners[0].selected).toBe(true);
    let started!: Promise<void>;
    await act(async () => {
      started = setup.start();
      await checking;
    });
    expect(onCreated).not.toHaveBeenCalled();
    expect(writes[0]).toMatchObject({
      defaultModel: '["custom","chosen"]',
      env: { DSH_HOME: '/private/home' },
      acp: { startupArgs: ['--profile', 'acp', '--patch', '/private/member.yml'] },
    });
    await act(async () => {
      finish(Response.json({ state: 'failed', reasonCode: 'tool_schema_rejected' }));
      await started;
    });
    expect(onCreated).toHaveBeenCalledOnce();
    expect(
      useToastStore
        .getState()
        .toasts.some((toast) => toast.message.includes('工具配置被模型拒绝') && toast.title.endsWith('已添加')),
    ).toBe(true);
    await act(async () => root.render(null));
    await act(async () => root.render(<Harness />));
    expect(Object.keys(setup.draft?.created ?? {})).toHaveLength(1);
    expect(setup.draft?.partners[0].form.env).toEqual({ DSH_HOME: '/private/home' });
    await act(async () => setup.start());
    expect(writes).toHaveLength(1);
    const calls = vi.mocked(apiFetch).mock.calls;
    expect(calls.filter(([path]) => path.endsWith('/prepare'))).toHaveLength(1);
    expect(calls.filter(([path]) => path.endsWith('/connection-check'))).toHaveLength(1);
    expect(calls.some(([path]) => path.endsWith('/test'))).toBe(false);
  } finally {
    await act(async () => root.unmount());
    localStorage.clear();
    vi.resetAllMocks();
    vi.unstubAllGlobals();
  }
});
