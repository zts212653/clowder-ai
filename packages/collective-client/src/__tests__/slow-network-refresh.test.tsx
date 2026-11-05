// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SharedArtifact } from '../collective-artifact-client.js';
import { useCollectiveClient } from '../use-collective-client.js';
import { useHostContext } from '../use-host-context.js';
import { SESSION_KEY } from '../use-human-auth-session.js';
import { snapshot as ready } from './first-entry-fixture.js';

let root: Root;
let container: HTMLDivElement;
let client: ReturnType<typeof useCollectiveClient>;
let delay: (path: string) => number;
let aborted: string[];
const { meta, me, collective } = ready;
if (!meta || !me || !collective) throw new Error('Authenticated fixture required');
const coordinates = { serviceInstanceId: meta.serviceInstanceId, collectiveId: collective.collectiveId };
const projection = { ...coordinates, works: [], roadmaps: [], votes: [], bindingVotes: [], decisions: [] };
const responses: Record<string, unknown> = {
  '/api/meta': { ...meta, capabilities: { channels: 1 } },
  '/api/auth/providers': { providers: [] },
  '/api/me': { ...me, collectives: [collective] },
  '/api/events/human': { events: [] },
  '/api/participants': { participants: ready.participants },
  '/api/members': ready.members,
  '/api/collaboration': projection,
  '/api/channels': { ...coordinates, channels: [] },
  '/api/artifacts/list': { artifacts: [] },
  '/api/pairing-intents': { ...coordinates, intentId: 'intent_12345678', nonce: 'fixture-nonce' },
  '/api/fixture-write': { saved: true },
  '/api/collaboration/materials/list': { items: [], pendingCount: 0, unavailable: [] },
  '/api/artifacts/management/read': {
    management: {
      ...coordinates,
      artifactId: 'artifact_fixture',
      canManageAccess: true,
      canManageCustody: true,
      custodyRevision: 1,
      custodyAvailable: true,
      snapshot: `sha256:${'1'.repeat(64)}`,
      offset: 0,
      total: 0,
      members: [],
    },
  },
};

function Harness() {
  client = useCollectiveClient();
  useHostContext(true, client.snapshot, 'general', ['general'], client.hostHumanSession);
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  sessionStorage.clear();
  localStorage.clear();
  history.replaceState(null, '', `/?collectiveId=${collective.collectiveId}`);
  sessionStorage.setItem(`${SESSION_KEY}:${location.origin}`, 'fixture-human-session');
  delay = () => 0;
  aborted = [];
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).split('?')[0] ?? '';
    if (!Object.hasOwn(responses, path)) throw new Error(`Unexpected request ${path}`);
    return new Promise<Response>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        aborted.push(path);
        reject(init?.signal?.reason ?? new DOMException('Cancelled by caller', 'AbortError'));
      };
      const latency = delay(path);
      const timer = Number.isFinite(latency)
        ? setTimeout(() => {
            init?.signal?.removeEventListener('abort', onAbort);
            resolve(new Response(JSON.stringify(responses[path]), { status: 200 }));
          }, latency)
        : undefined;
      init?.signal?.addEventListener('abort', onAbort, { once: true });
    });
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  sessionStorage.clear();
  localStorage.clear();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// Flush React effects between transport completions, without real network or wall-clock sleeps.
async function advance(milliseconds: number) {
  for (let elapsed = 0; elapsed < milliseconds; elapsed += 100) {
    await act(async () => vi.advanceTimersByTimeAsync(Math.min(100, milliseconds - elapsed)));
  }
}

it('finishes the first projection over a 700ms serial transport instead of cancelling it every poll', async () => {
  delay = () => 700;
  await act(async () => root.render(<Harness />));
  await advance(9_000);

  expect(client.snapshot.phase).toBe('ready');
  expect(client.snapshot.collaboration).toEqual(projection);
  expect(client.snapshot.members).toEqual(ready.members);
  expect(client.snapshot.participants).toEqual(ready.participants);
  expect(client.artifacts.status).toBe('ready');
  expect(client.snapshot.error).toBeUndefined();
  expect(aborted).toEqual([]);
});

it('shows a slow works catalogue when its response crosses polling ticks', async () => {
  delay = (path) => (path === '/api/artifacts/list' ? 2_500 : 0);
  await act(async () => root.render(<Harness />));
  await advance(6_000);

  expect(client.artifacts.status).toBe('ready');
  expect(client.artifacts.catalogue).toEqual([]);
  expect(client.artifacts.error).toBeUndefined();
});

it.each([
  '/api/collaboration',
  '/api/artifacts/list',
])('recovers a stalled read at %s without overlapping automatic retries', async (path) => {
  let reads = 0;
  delay = (value) => (value === path && ++reads === 1 ? Infinity : 0);
  await act(async () => root.render(<Harness />));
  await advance(29_000);
  expect(reads).toBe(1);
  expect(aborted).toEqual([]);
  await advance(6_000);
  expect(aborted).toEqual([path]);
  expect(reads).toBeGreaterThan(1);
  expect(client.snapshot.collaboration).toEqual(projection);
  expect(client.artifacts.status).toBe('ready');
  expect(client.snapshot.error).toBeUndefined();
  expect(sessionStorage.getItem(`${SESSION_KEY}:${location.origin}`)).toBe('fixture-human-session');
});

it.each([
  'materials',
  'permissions',
] as const)('releases the serial lane after a stalled %s POST read', async (kind) => {
  await act(async () => root.render(<Harness />));
  await advance(100);
  const path = kind === 'materials' ? '/api/collaboration/materials/list' : '/api/artifacts/management/read';
  const artifact = { ...coordinates, artifactId: 'artifact_fixture' } as SharedArtifact;
  const api = client.artifacts.api;
  if (!api) throw new Error('Expected the authenticated artifact client');
  const read = () =>
    kind === 'materials' ? client.materialClient.list('roadmap_fixture') : api.management.read(artifact);
  let reads = 0;
  delay = (value) => (value === path && ++reads === 1 ? Infinity : 0);
  let outcome = 'pending';
  void read().then(
    () => {
      outcome = 'success';
    },
    () => {
      outcome = 'failed';
    },
  );
  await advance(29_000);
  expect(outcome).toBe('pending');
  expect(reads).toBe(1);
  await advance(2_000);
  expect(outcome).toBe('failed');
  expect(aborted).toEqual([path]);
  const next = read();
  await advance(1_000);
  await expect(next).resolves.toEqual(
    kind === 'materials' ? responses[path] : (responses[path] as { management: unknown }).management,
  );
  expect(reads).toBe(2);
});

it('does not time out or replay a write, and starts queued read deadlines only when admitted', async () => {
  await act(async () => root.render(<Harness />));
  await advance(100);
  let writes = 0;
  delay = (path) => {
    if (path !== '/api/fixture-write') return 0;
    writes++;
    return 35_000;
  };
  const pending = client.hostHumanSession.request('/api/fixture-write', { method: 'POST', body: '{}' });
  await advance(33_000);
  expect(writes).toBe(1);
  expect(aborted).toEqual([]);
  await advance(4_000);
  await expect(pending).resolves.toEqual({ saved: true });
  expect(writes).toBe(1);
  expect(aborted).toEqual([]);
  expect(client.snapshot.error).toBeUndefined();
});

it('clears the pairing progress notice only after the matching Host confirms a connected identity', async () => {
  const parent = { postMessage: vi.fn() } as unknown as Window;
  vi.spyOn(window, 'parent', 'get').mockReturnValue(parent);
  history.replaceState(null, '', `/?collectiveId=${collective.collectiveId}&hostOrigin=https%3A%2F%2Fcafe.test`);
  await act(async () => root.render(<Harness />));
  await advance(100);
  let pairing: Promise<void> | undefined;
  await act(async () => {
    pairing = client.pairHost();
  });
  await advance(100);
  await pairing;
  expect(client.snapshot.notice).toBe('Clowder AI 正在安全托管连接凭据…');

  const hostInit = async (humanId: string, authorityStatus: 'connected' | 'revoked') => {
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: 'https://cafe.test',
          source: parent,
          data: {
            type: 'collective:host-context-init',
            bridgeId: 'bridge_12345678',
            ...coordinates,
            connectionId: 'con_12345678',
            humanId,
            authorityStatus,
          },
        }),
      );
    });
  };
  await hostInit('human_someoneelse', 'connected');
  expect(client.snapshot.notice).toBe('Clowder AI 正在安全托管连接凭据…');
  await hostInit(me.human.humanId, 'revoked');
  expect(client.snapshot.notice).toBe('Clowder AI 正在安全托管连接凭据…');
  await hostInit(me.human.humanId, 'connected');
  expect(client.snapshot.notice).toBeUndefined();
});
