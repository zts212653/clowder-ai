import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { apiFetch } from '@/utils/api-client';
import { useNativeOnboarding } from '../first-run-quest/useNativeOnboarding';
import { buildCatPayload } from '../hub-cat-editor.payload';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
const roster = vi.hoisted(() => ({ cats: [] as CatData[] }));
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ cats: roster.cats, refresh: vi.fn() }) }));
const descriptors = [
  ['adapter.js', '--profile', 'acp', '--fixture-scope', 'scope-2011b24d278a'],
  ['adapter.js', '--profile', 'acp', '--fixture-scope', 'scope-650394ff536e'],
];
const cases = (['members', 'goal'] as const).flatMap((mode) =>
  [false, true].flatMap((reverse) => [false, true].map((committed) => ({ mode, reverse, committed }))),
);
it.each(cases)('recovers legacy pending: $mode, reverse=$reverse, committed=$committed', async ({
  mode,
  reverse,
  committed,
}) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  roster.cats = [];
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const writes: unknown[] = [];
  let setup: ReturnType<typeof useNativeOnboarding> | undefined;
  let probeReversed = false;
  const receipts = new Map<string, string>();
  const response = (value: unknown) => new Response(JSON.stringify(value));
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path === '/api/cats' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      const requestKey = new Headers(init.headers).get('Idempotency-Key');
      writes.push({ body, requestKey });
      if (receipts.has(requestKey!) && receipts.get(requestKey!) !== JSON.stringify(body))
        return new Response(JSON.stringify({ error: 'receipt belongs to different configuration' }), { status: 409 });
      receipts.set(requestKey!, JSON.stringify(body));
      const first = JSON.stringify(body.acp.startupArgs) === JSON.stringify(descriptors[0]);
      const id = first ? 'dsh' : 'dsh-2';
      if (!roster.cats.some((cat) => cat.id === id)) roster.cats.push({ ...body, id } as CatData);
      return response({
        cat: {
          id: first ? 'dsh' : 'dsh-2',
          displayName: body.displayName,
          mentionPatterns: [first ? '@dsh' : '@dsh-2'],
        },
      });
    }
    if (path === '/api/threads' && init?.method === 'POST') return response({ id: 'review-goal' });
    if (path === '/api/config/onboarding/entry') return response({ status: 'pending' });
    if (init?.method) throw Error('Unexpected fixture write');
    if (path === '/api/session') return response({ userId: 'review-owner' });
    if (path === '/api/cat-templates') return response({ templates: [] });
    if (path === '/api/cats') return response({ cats: roster.cats });
    if (String(path).startsWith('/api/cats/native-runtimes'))
      return response({
        runtimes: (probeReversed ? descriptors.toReversed() : descriptors).map((startupArgs, n) => ({
          id: 'acp-fixture-' + n,
          label: 'DSH',
          clientId: 'acp',
          installed: true,
          models: [],
          acp: { command: 'node', startupArgs, transport: 'stdio' },
        })),
      });
    throw Error('Unexpected fixture request: ' + path);
  });
  function Probe() {
    setup = useNativeOnboarding(true, vi.fn(), mode);
    return null;
  }
  try {
    await act(async () => root.render(<Probe />));
    expect(setup?.draft?.partners).toHaveLength(2);
    const key = `cat-cafe:${mode === 'members' ? 'native-team-setup' : 'native-onboarding'}:v2:review-owner`;
    const saved = JSON.parse(localStorage.getItem(key)!);
    const oldKey = 'acp-ea7466ba';
    // The old API committed the first descriptor, but the client received no response or receipt.
    for (const partner of saved.partners) {
      partner.id = oldKey;
      partner.creationRequestKey = undefined;
    }
    saved.lead = oldKey;
    saved.created = {};
    localStorage.setItem(key, JSON.stringify(saved));
    const originalBody = buildCatPayload(saved.partners[0].form);
    const originalKey = `onboarding:${saved.journeyId}:cat:${oldKey}`;
    if (committed) {
      roster.cats = [{ ...originalBody, id: 'dsh' } as CatData];
      receipts.set(originalKey, JSON.stringify(originalBody));
    }
    probeReversed = reverse;
    await act(async () => root.render(<Probe />));
    await act(async () => setup?.reload());
    expect(setup?.draft?.partners.map((p) => p.form.catId).sort()).toEqual(['dsh', 'dsh-2']);
    await act(async () => setup?.start());
    expect(writes[0]).toEqual({ body: originalBody, requestKey: originalKey });
    expect(setup?.error).toBe('');
    expect(
      writes,
      'the original pending key must recover the first member, while the distinct second descriptor needs its own request',
    ).toHaveLength(2);
    await act(async () => setup?.reload());
    await act(async () => setup?.start());
    expect(writes).toHaveLength(2);
    expect(setup?.error).toBe('');
    expect(new Set(Object.values(setup?.draft?.created ?? {}).map((member) => member.id)).size).toBe(2);
  } finally {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.resetAllMocks();
  }
});
