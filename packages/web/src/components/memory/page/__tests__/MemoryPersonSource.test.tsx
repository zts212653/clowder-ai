import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryPersonClaim } from '../MemoryPersonClaim';
import { MemoryPersonInteraction } from '../MemoryPersonInteraction';
import { MemoryPersonSource } from '../MemoryPersonSource';

const fetch = vi.hoisted(() => vi.fn());
vi.mock('@/utils/api-client', () => ({ apiFetch: fetch }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
let host: HTMLDivElement;
let root: Root;
const response = (body: unknown, status = 200) => Promise.resolve({ ok: status < 400, status, json: async () => body });

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.resetAllMocks();
});
const open = () => act(async () => root.render(<MemoryPersonSource personId="person_fixture" />));

it('states that a successfully resolved unavailable source is unavailable without offering a retry', async () => {
  fetch.mockImplementation(() => response({ status: 'unavailable', sources: [] }));
  await open();
  expect(host.textContent).toBe('来源已不可用');
  expect(host.querySelector('button')).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(1);
});

it.each(['claim', 'event'])('does not advertise retry in the unavailable %s editor notice', async (kind) => {
  fetch.mockImplementation(() => response({ status: 'unavailable', sources: [] }));
  const revision = `sha256:${'a'.repeat(64)}`;
  await act(async () =>
    root.render(
      kind === 'claim' ? (
        <MemoryPersonClaim
          personId="person_fixture"
          busy={false}
          submit={vi.fn()}
          claim={{
            claimId: 'claim_fixture',
            revision,
            payload: { kind: 'reported_fact', predicate: 'role', value: '合成事实', assertedBy: 'owner' },
            status: 'current',
            recordedAt: 1,
            sourceCount: 1,
          }}
        />
      ) : (
        <MemoryPersonInteraction
          personId="person_fixture"
          busy={false}
          submit={vi.fn()}
          item={{
            eventId: 'event_fixture',
            revision,
            eventKind: 'meeting',
            headline: '合成见面',
            status: 'active',
            recordedAt: 1,
            sourceCount: 1,
          }}
        />
      ),
    ),
  );
  expect(host.textContent).toContain('来源已不可用');
  expect(host.textContent).not.toContain('重读来源');
  expect(Array.from(host.querySelectorAll('button')).find((button) => button.textContent === '编辑')?.disabled).toBe(
    true,
  );
});

it.each(['http', 'network'])('offers a working retry after a transient %s failure', async (kind) => {
  fetch.mockImplementationOnce(() =>
    kind === 'http' ? response({ status: 'unavailable', sources: [] }, 503) : Promise.reject(new Error('offline')),
  );
  fetch.mockImplementation(() =>
    response({
      status: 'ready',
      sources: [{ kind: 'owner_action', label: '你在记忆页修改', occurredAt: 1, canOpen: false }],
    }),
  );
  await open();
  expect(host.textContent).toContain('来源暂时读不到');
  const retry = host.querySelector('button');
  expect(retry?.textContent).toBe('重读来源');
  await act(async () => retry?.click());
  expect(host.textContent).toContain('你在记忆页修改');
  expect(host.textContent).not.toContain('来源已不可用');
  expect(fetch).toHaveBeenCalledTimes(2);
});
