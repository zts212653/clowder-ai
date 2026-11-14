import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { runtimeDefaults } from '../../settings/members/member-runtime-draft';
import { useNativeOnboarding } from '../useNativeOnboarding';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ refresh: vi.fn() }) }));
const desktops = ['first', 'second'].map((name) => ({
  id: `dsh:${name}`,
  label: `DSH Desktop ${name}`,
  clientId: 'acp' as const,
  installed: true,
  dshDesktop: true,
  models: [],
  acp: { command: `/${name}/resources/runtime/cli/bin/dsh.cmd`, startupArgs: ['--profile', 'acp'] },
}));
let root: Root;
let host: HTMLDivElement;
let setup: ReturnType<typeof useNativeOnboarding>;
let available = desktops;
let committed = false;
const writes: RequestInit[] = [];
const onCreated = vi.fn();
function Harness({ mode }: { mode: 'members' | 'goal' }) {
  setup = useNativeOnboarding(true, onCreated, mode);
  return <p>{setup.error}</p>;
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  available = desktops;
  committed = false;
  writes.length = 0;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path === '/api/session') return Response.json({ userId: 'desktop-owner' });
    if (path.startsWith('/api/cats/native-runtimes')) return Response.json({ runtimes: available });
    if (path === '/api/cat-templates') return Response.json({ templates: [] });
    if (path === '/api/config/onboarding/entry') return Response.json({ status: 'pending' });
    if (path.endsWith('/inspect')) {
      expect(JSON.parse(String(init?.body)).runtimeId).toBe(desktops[1].id);
      return Response.json({
        revision: 'r',
        provider: 'custom',
        model: 'chosen',
        providers: [{ id: 'custom', credential: 'configured', models: [{ id: 'chosen' }] }],
      });
    }
    if (path.endsWith('/prepare')) {
      expect(JSON.parse(String(init?.body)).runtimeId).toBe(desktops[1].id);
      return Response.json({
        command: desktops[1].acp.command,
        startupArgs: ['--profile', 'acp', '--patch', '/private/second/member.yml'],
        env: { DSH_HOME: '/private/second/home' },
        provider: 'custom',
        model: 'chosen',
      });
    }
    if (path === '/api/cats' && init?.method === 'POST') {
      writes.push(init);
      if (writes.length === 1) throw Error('POST response lost');
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return Response.json({ cat: { ...body, id: body.catId } }, { status: 201 });
    }
    if (path === '/api/cats') {
      const body = writes.length && committed ? (JSON.parse(String(writes[0].body)) as Record<string, unknown>) : null;
      return Response.json({
        cats: body ? [{ ...body, id: body.catId, color: { primary: '#123456', secondary: '#abcdef' } }] : [],
      });
    }
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
  { mode: 'members', saved: false },
  { mode: 'members', saved: true },
  { mode: 'goal', saved: false },
  { mode: 'goal', saved: true },
] as const)('replays the selected second Desktop after lost POST response: $mode / saved=$saved', async ({
  mode,
  saved,
}) => {
  committed = saved;
  await act(async () => root.render(<Harness mode={mode} />));
  const initial = setup.draft!.partners[0];
  await act(async () => setup.patchPartner(initial.id, { form: { ...initial.form, ...runtimeDefaults(desktops[1]) } }));
  await act(async () => setup.start());
  expect(writes).toHaveLength(1);
  expect(setup.error).toContain('POST response lost');
  const pending = setup.draft!.partners[0];
  expect(pending.creationForm).toBeDefined();
  expect(pending.runtime.acp?.command).toBe(desktops[1].acp.command);
  await act(async () => root.unmount());
  root = createRoot(host);
  await act(async () => root.render(<Harness mode={mode} />));
  const restored = setup.draft!.partners[0];
  expect(restored.creationRequestKey).toBe(pending.creationRequestKey);
  expect(restored.creationForm).toEqual(pending.creationForm);
  expect(restored.runtime.acp?.command).toBe(desktops[1].acp.command);
  expect(restored.form.catId).toBe(pending.form.catId);
  await act(async () => setup.start());
  expect(writes).toHaveLength(2);
  expect(writes[1].body).toBe(writes[0].body);
  expect(new Headers(writes[1].headers).get('Idempotency-Key')).toBe(
    new Headers(writes[0].headers).get('Idempotency-Key'),
  );
  expect(vi.mocked(apiFetch).mock.calls.filter(([path]) => path.endsWith('/prepare'))).toHaveLength(1);
  expect(onCreated).toHaveBeenCalledOnce();
});

it.each(['missing', 'reused id'])('does not attach the pending intent to another Desktop: %s', async (change) => {
  await act(async () => root.render(<Harness mode="members" />));
  const initial = setup.draft!.partners[0];
  await act(async () => setup.patchPartner(initial.id, { form: { ...initial.form, ...runtimeDefaults(desktops[1]) } }));
  await act(async () => setup.start());
  const pending = setup.draft!.partners[0];
  available =
    change === 'missing'
      ? [desktops[0]]
      : [desktops[0], { ...desktops[1], acp: { ...desktops[1].acp, command: '/different/dsh.cmd' } }];
  await act(async () => root.unmount());
  root = createRoot(host);
  await act(async () => root.render(<Harness mode="members" />));
  const restored = setup.draft!.partners[0];
  expect(restored.creationForm).toBeUndefined();
  expect(restored.creationRequestKey).not.toBe(pending.creationRequestKey);
  expect(restored.runtime.acp?.command).toBe(desktops[0].acp.command);
  expect(writes).toHaveLength(1);
});
