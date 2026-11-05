import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { apiFetch } from '@/utils/api-client';
import { buildCatPayload } from '../../hub-cat-editor.payload';
import { recommendNativePartners } from '../native-onboarding';
import { useNativeOnboarding } from '../useNativeOnboarding';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
const roster = vi.hoisted(() => ({ cats: [] as CatData[] }));
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ cats: roster.cats, refresh: vi.fn() }) }));
const storageKey = 'cat-cafe:native-team-setup:v2:owner-a';
const runtime = {
  id: 'dsh',
  label: 'DSH',
  clientId: 'acp' as const,
  installed: true,
  models: [],
  acp: { command: 'dsh', startupArgs: ['--profile', '1e1unfl'], transport: 'stdio' as const },
};
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
let root: Root, container: HTMLDivElement;
let setup: ReturnType<typeof useNativeOnboarding>;
const onCreated = vi.fn();
function Harness({ mode = 'members' }: { mode?: 'members' | 'goal' }) {
  setup = useNativeOnboarding(true, onCreated, mode);
  return <p>{setup.loading ? 'loading' : setup.error}</p>;
}
function installDiscovery(peer: typeof runtime, cats: CatData[], post: (init: RequestInit) => Response) {
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path === '/api/session') return response({ userId: 'owner-a' });
    if (path === '/api/config/onboarding/entry') return response({ status: 'pending' });
    if (String(path).split('?')[0] === '/api/cats/native-runtimes') return response({ runtimes: [peer] });
    if (path === '/api/cat-templates') return response({ templates: [] });
    if (path === '/api/cats') return init?.method === 'POST' ? post(init) : response({ cats });
    if (path === '/api/threads') return response({ id: 'first-goal' }, 201);
    throw new Error(`unexpected path ${path}`);
  });
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  roster.cats = [];
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

it('replays an old short-v1 ACP pending receipt with its original key and unchanged payload', async () => {
  const partner = recommendNativePartners([runtime], [], [], 'journey-original')[0];
  const legacy = { ...partner, creationRequestKey: undefined };
  const original = { ...legacy, id: 'acp-583e2d40' };
  const payload = buildCatPayload(original.form);
  const expectedKey = 'onboarding:journey-original:cat:acp-583e2d40';
  localStorage.setItem(
    storageKey,
    JSON.stringify({
      version: 2,
      idScheme: 'short-v1',
      journeyId: 'journey-original',
      partners: [original],
      created: {},
    }),
  );
  // The API committed this exact request, but its response never reached the old browser.
  const committed = { ...payload, id: original.form.catId } as CatData;
  installDiscovery(runtime, [committed], (init) => {
    const sameReceipt = new Headers(init.headers).get('Idempotency-Key') === expectedKey;
    return response({ cat: { ...committed, id: sameReceipt ? committed.id : 'dsh-2' } }, 201);
  });
  await act(async () => root.render(<Harness />));
  expect(setup.draft!.partners[0].form.catId).toBe(original.form.catId);
  await act(async () => setup.start());
  const request = vi.mocked(apiFetch).mock.calls.find(([, init]) => init?.method === 'POST')![1]!;
  expect(new Headers(request.headers).get('Idempotency-Key')).toBe(expectedKey);
  expect(request.body).toBe(JSON.stringify(payload));
  expect(onCreated).toHaveBeenCalledWith(committed.id, committed.displayName);
});

it('bounds ACP request keys independently of descriptor size and persists them before retry', async () => {
  const peer = { ...runtime, acp: { ...runtime.acp, startupArgs: ['--profile', '猫'.repeat(1200)] } };
  let loseResponse = true;
  installDiscovery(peer, [], (init) => {
    if (new Headers(init.headers).get('Idempotency-Key')!.length > 2048)
      return response({ error: 'request key too long' }, 409);
    if (loseResponse) {
      loseResponse = false;
      return response({ error: 'response lost' }, 503);
    }
    const payload = JSON.parse(String(init.body));
    return response({ cat: { ...payload, id: 'dsh' } }, 201);
  });
  await act(async () => root.render(<Harness />));
  await act(async () => setup.start());
  expect(setup.error).toContain('小鲸鱼');
  expect(setup.error).toContain('DSH');
  expect(setup.error).toContain('response lost');
  act(() => root.unmount());
  root = createRoot(container);
  await act(async () => root.render(<Harness />));
  await act(async () => setup.start());
  const requests = vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(requests).toHaveLength(2);
  expect(requests[1][1]!.headers).toEqual(requests[0][1]!.headers);
  expect(new Headers(requests[0][1]!.headers).get('Idempotency-Key')!.length).toBeLessThan(128);
  expect(requests[1][1]!.body).toBe(requests[0][1]!.body);
  expect(JSON.parse(String(requests[1][1]!.body)).acp.startupArgs).toEqual(peer.acp.startupArgs);
  expect(onCreated).toHaveBeenCalledOnce();
});

it.each([
  'members',
  'goal',
] as const)('validates legacy created receipts against each descriptor in %s mode', async (mode) => {
  const peers = ['1e1unfl', 'hlxo45'].map((profile) => ({
    ...runtime,
    acp: { ...runtime.acp, startupArgs: ['--profile', profile] },
  }));
  const partners = recommendNativePartners(peers, [], [], 'old-collision').map((p) => {
    const legacy = { ...p, creationRequestKey: undefined };
    return { ...legacy, id: 'acp-583e2d40', form: { ...p.form, catId: 'dsh' } };
  });
  const key = `cat-cafe:${mode === 'members' ? 'native-team-setup' : 'native-onboarding'}:v2:owner-a`;
  localStorage.setItem(
    key,
    JSON.stringify({
      version: 2,
      idScheme: 'short-v1',
      journeyId: 'old-collision',
      partners,
      goal: '整理想法',
      lead: 'acp-583e2d40',
      created: { 'acp-583e2d40': { id: 'dsh', name: 'First profile', mention: '@dsh' } },
    }),
  );
  roster.cats = [{ ...buildCatPayload(partners[0].form), id: 'dsh' } as CatData];
  const writes: RequestInit[] = [];
  installDiscovery(runtime, roster.cats, (init) => {
    writes.push(init);
    // The acknowledged old request belongs to the FIRST descriptor. It cannot create the second.
    if (new Headers(init.headers).get('Idempotency-Key') === 'onboarding:old-collision:cat:acp-583e2d40')
      return response({ error: 'receipt belongs to different configuration' }, 409);
    return response({ cat: { id: 'dsh-2', displayName: 'Second profile', mentionPatterns: ['@dsh-2'] } }, 201);
  });
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) =>
    String(path).startsWith('/api/cats/native-runtimes') ? response({ runtimes: peers }) : original(path, init),
  );
  await act(async () => root.render(<Harness mode={mode} />));
  expect(setup.draft?.partners.map((p) => p.form.catId)).toEqual(['dsh', 'dsh']);
  await act(async () => setup.start());
  expect(writes).toHaveLength(1);
  expect(JSON.parse(String(writes[0].body)).acp.startupArgs).toEqual(peers[1].acp.startupArgs);
  expect(Object.values(setup.draft!.created).map((member) => member.id)).toEqual(['dsh', 'dsh-2']);
  expect(setup.error).toBe('');
});
