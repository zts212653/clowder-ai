import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    getCatById: (id: string) =>
      id === 'gemini25'
        ? {
            id,
            displayName: '暹罗猫',
            nickname: '烁烁',
            name: 'Gemini',
            breed: 'siamese',
            color: { primary: '#000', secondary: '#fff' },
          }
        : undefined,
  }),
}));
vi.mock('../../thread-chat', () => ({ ThreadChatSurface: () => <div data-testid="thread-chat-surface" /> }));
vi.mock('../useConciergeConfirmations', () => ({
  useConciergeConfirmations: () => ({ confirmations: new Map(), loading: false, error: null }),
}));

import { useConciergeStore } from '@/stores/conciergeStore';
import { apiFetch } from '@/utils/api-client';
import { ConciergePanel } from '../ConciergePanel';

const mockApiFetch = vi.mocked(apiFetch);
const selectedIdentity = {
  v: 1,
  name: '猫猫球',
  partner: { catId: 'gemini25', displayName: '烁烁', skin: 'ragdoll-v1' },
  live: { catId: 'codex6-sol', displayName: '砚砚', transport: 'gpt_live_v3', verifiedModel: null },
  deep: { catId: 'gemini25', displayName: '烁烁', verifiedModel: null },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  mockApiFetch.mockReset();
  useConciergeStore.setState({
    surfaceState: 'bubble',
    dutyCatProfileId: 'gemini25',
    threadId: 'thread-identity-test',
    threadIdLoaded: true,
    threadIdLoading: false,
    muted: false,
    invocationStatus: 'idle',
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

async function renderPanel() {
  await act(async () => {
    root.render(<ConciergePanel />);
    await Promise.resolve();
  });
}

it('names the actual Live carrier from the owner-local Host selection while the portrait stays with the chosen partner', async () => {
  mockApiFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ status: 'selected', identity: selectedIdentity }),
  } as Response);

  await renderPanel();

  expect(mockApiFetch).toHaveBeenCalledWith(
    '/api/concierge/live/identity',
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
    { afterCurrentGet: true },
  );
  expect(
    container.querySelector('[data-testid="concierge-status-avatar"]')?.getAttribute('data-companion-cat-id'),
  ).toBe('gemini25');
  expect(container.textContent).toContain('Live 快端：砚砚 · 型号未核实');
  expect(container.textContent).toContain('深思端：烁烁 · 型号未核实');
});

it('does not show a Host snapshot for another selected partner as the current identity', async () => {
  mockApiFetch.mockResolvedValue({
    ok: true,
    json: async () => ({
      status: 'selected',
      identity: {
        ...selectedIdentity,
        partner: { catId: 'fable-5', displayName: '宪宪', skin: 'xianxian-codex' },
        deep: { catId: 'fable-5', displayName: '宪宪', verifiedModel: null },
        live: { ...selectedIdentity.live, displayName: '过期载体' },
      },
    }),
  } as Response);

  await renderPanel();

  expect(
    container.querySelector('[data-testid="concierge-status-avatar"]')?.getAttribute('data-companion-cat-id'),
  ).toBe('gemini25');
  expect(container.textContent).toContain('Live 快端：载体待确认');
  expect(container.textContent).not.toContain('过期载体');
  expect(container.textContent).not.toContain('宪宪陪伴中');
});

it('starts a fresh physical Host read after an explicit partner switch while the old GET remains active', async () => {
  const old = deferred<Response>();
  const next = deferred<Response>();
  const originalFetch = globalThis.fetch;
  let identityCalls = 0;
  const physicalFetch = vi.fn((url: string) => {
    if (url.includes('/api/session')) return Promise.resolve(new Response('{}'));
    if (url.includes('/api/concierge/live/identity')) {
      identityCalls += 1;
      return identityCalls === 1 ? old.promise : next.promise;
    }
    return Promise.reject(new Error(`Unexpected request: ${url}`));
  });
  globalThis.fetch = physicalFetch as typeof fetch;
  const { apiFetch: realApiFetch } = await vi.importActual<typeof import('@/utils/api-client')>('@/utils/api-client');
  mockApiFetch.mockImplementation(realApiFetch);

  try {
    await renderPanel();
    await vi.waitFor(() => expect(identityCalls).toBe(1));
    await act(async () => useConciergeStore.setState({ dutyCatProfileId: 'fable-5' }));
    expect(
      container.querySelector('[data-testid="concierge-status-avatar"]')?.getAttribute('data-companion-cat-id'),
    ).toBe('fable-5');
    expect(container.textContent).toContain('Live 快端：载体待确认');

    await act(async () => {
      old.resolve(new Response(JSON.stringify({ status: 'selected', identity: selectedIdentity })));
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(identityCalls).toBe(2));
    await act(async () => {
      next.resolve(
        new Response(
          JSON.stringify({
            status: 'selected',
            identity: {
              ...selectedIdentity,
              partner: { catId: 'fable-5', displayName: '宪宪', skin: 'xianxian-codex' },
              deep: { catId: 'fable-5', displayName: '宪宪', verifiedModel: null },
              live: { ...selectedIdentity.live, displayName: '新载体' },
            },
          }),
        ),
      );
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(container.textContent).toContain('Live 快端：新载体 · 型号未核实'));
    expect(container.textContent).not.toContain('烁烁陪伴中');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
