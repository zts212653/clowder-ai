import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { useNativeOnboarding } from '../useNativeOnboarding';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ refresh: vi.fn() }) }));
let host: HTMLDivElement, root: Root;
let setup: ReturnType<typeof useNativeOnboarding>;
let failure: { status: number; error: string; code?: string };
const writes: RequestInit[] = [];
const onCreated = vi.fn();
function Harness({ mode = 'members' }: { mode?: 'members' | 'goal' }) {
  setup = useNativeOnboarding(true, onCreated, mode);
  return <p>{setup.error}</p>;
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  writes.length = 0;
  failure = { status: 400, error: 'Invalid request' };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const runtime = {
    id: 'dsh',
    label: 'DSH Desktop',
    clientId: 'acp',
    installed: true,
    dshDesktop: true,
    models: [],
    acp: { command: '/desktop/dsh.cmd', startupArgs: ['--profile', 'acp'] },
  };
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path === '/api/session') return Response.json({ userId: 'rejection-owner' });
    if (path.startsWith('/api/cats/native-runtimes')) return Response.json({ runtimes: [runtime] });
    if (path === '/api/cat-templates') return Response.json({ templates: [] });
    if (path === '/api/config/onboarding/entry') return Response.json({ status: 'pending' });
    if (path.endsWith('/inspect'))
      return Response.json({
        revision: 'r',
        provider: 'custom',
        model: 'model',
        providers: [{ id: 'custom', credential: 'configured', models: [{ id: 'model' }] }],
      });
    if (path.endsWith('/prepare'))
      return Response.json({
        command: runtime.acp.command,
        startupArgs: ['--profile', 'acp', '--patch', '/private/member.yml'],
        env: { DSH_HOME: '/private/home' },
        provider: 'custom',
        model: 'model',
      });
    if (path === '/api/cats' && init?.method === 'POST') {
      writes.push(init);
      if (writes.length === 1)
        return Response.json(
          { error: failure.error, ...(failure.code ? { code: failure.code } : {}) },
          { status: failure.status },
        );
      const body = JSON.parse(String(init.body));
      return Response.json({ cat: { ...body, id: body.catId } }, { status: 201 });
    }
    if (path === '/api/cats') return Response.json({ cats: [] });
    if (path === '/api/threads') return Response.json({ id: 'goal-thread' });
    throw Error(`Unexpected ${path}`);
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  localStorage.clear();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

it.each([
  'members',
  'goal',
] as const)('allows correction and a fresh request after validation rejection and reopening (%s)', async (mode) => {
  await act(async () => root.render(<Harness mode={mode} />));
  await act(async () => setup.start());
  expect(writes).toHaveLength(1);
  expect(setup.draft!.partners[0].creationForm).toBeUndefined();
  expect(Object.keys(setup.draft!.created)).toHaveLength(0);
  await act(async () => root.unmount());
  root = createRoot(host);
  await act(async () => root.render(<Harness mode={mode} />));
  const partner = setup.draft!.partners[0];
  await act(async () => setup.patchPartner(partner.id, { form: { ...partner.form, nickname: 'Corrected Whale' } }));
  await act(async () => setup.start());
  expect(writes).toHaveLength(2);
  expect(new Headers(writes[1].headers).get('Idempotency-Key')).not.toBe(
    new Headers(writes[0].headers).get('Idempotency-Key'),
  );
  expect(JSON.parse(String(writes[1].body)).nickname).toBe('Corrected Whale');
  expect(onCreated).toHaveBeenCalledOnce();
});

it.each([
  400, 408, 409, 503,
])('retains exact frozen intent for an uncertain or receipt-conflicting response (%s)', async (status) => {
  failure = { status, error: 'write result unknown or receipt conflict' };
  await act(async () => root.render(<Harness />));
  await act(async () => setup.start());
  const frozen = setup.draft!.partners[0].creationForm;
  expect(frozen).toBeDefined();
  await act(async () => root.unmount());
  root = createRoot(host);
  await act(async () => root.render(<Harness />));
  const partner = setup.draft!.partners[0];
  await act(async () => setup.patchPartner(partner.id, { form: { ...partner.form, nickname: 'Different request' } }));
  await act(async () => setup.start());
  expect(writes).toHaveLength(1);
  expect(setup.error).toContain('上次创建结果待核对');
  await act(async () => setup.patchPartner(partner.id, { form: frozen }));
  await act(async () => setup.start());
  expect(writes).toHaveLength(2);
  expect(writes[1].body).toBe(writes[0].body);
  expect(new Headers(writes[1].headers).get('Idempotency-Key')).toBe(
    new Headers(writes[0].headers).get('Idempotency-Key'),
  );
  expect(onCreated).toHaveBeenCalledOnce();
});

it('releases the frozen form for an explicit pre-write ACP-profile rejection', async () => {
  failure = { status: 400, error: 'Invalid ACP profile', code: 'acp_profile_invalid' };
  await act(async () => root.render(<Harness />));
  await act(async () => setup.start());
  expect(setup.draft!.partners[0].creationForm).toBeUndefined();
  await act(async () => setup.start());
  expect(writes).toHaveLength(2);
  expect(new Headers(writes[1].headers).get('Idempotency-Key')).not.toBe(
    new Headers(writes[0].headers).get('Idempotency-Key'),
  );
  expect(onCreated).toHaveBeenCalledOnce();
});
