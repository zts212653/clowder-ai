import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

it('StrictMode reuses the initial physical read and does not queue another refusal', async () => {
  const first = deferredResponse();
  const fetch = vi.fn((input: RequestInfo | URL) =>
    String(input).endsWith('/api/session') ? Promise.resolve(reply({ csrfToken: 'test-only' })) : first.promise,
  );
  vi.stubGlobal('fetch', fetch);
  const { useTextMessageRequest } = await import('../useTextMessageRequest');
  function Probe() {
    const { found } = useTextMessageRequest({ messageId: 'strict-message', sentAt: 1 });
    return <output>{found?.requestId ?? 'no request'}</output>;
  }
  await act(async () =>
    root.render(
      <StrictMode>
        <Probe />
      </StrictMode>,
    ),
  );
  const reads = () => fetch.mock.calls.filter(([url]) => String(url).includes('/by-message/'));
  expect(reads()).toHaveLength(1);
  await act(async () => {
    first.resolve(reply({ error: 'access_denied' }, 403));
    await new Promise((done) => setTimeout(done, 20));
  });
  expect(reads(), 'a mount is not a mutation that needs a trailing GET').toHaveLength(1);
  expect(host.textContent).toBe('no request');
});

it('a projection event during a pending read still gets a fresh physical generation', async () => {
  const first = deferredResponse();
  let reads = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      if (String(input).endsWith('/api/session')) return Promise.resolve(reply({ csrfToken: 'test-only' }));
      if (++reads === 1) return first.promise;
      return Promise.resolve(
        reply({
          record: {
            requestId: 'request-after-event',
            progress: { sourceKind: 'human_message', sourceMessageId: 'event-message' },
            payload: { targetCatId: 'codex61-sol' },
          },
        }),
      );
    }),
  );
  const { useTextMessageRequest } = await import('../useTextMessageRequest');
  function Probe() {
    const { found } = useTextMessageRequest({ messageId: 'event-message', sentAt: 1 });
    return <output>{found?.requestId ?? 'no request'}</output>;
  }
  await act(async () => root.render(<Probe />));
  await act(async () => window.dispatchEvent(new Event('cat-cafe:entrusted-work-projection-invalidated')));
  expect(reads).toBe(1);
  await act(async () => {
    first.resolve(reply({ error: 'not_found' }, 404));
    await new Promise((done) => setTimeout(done, 20));
  });
  expect(reads).toBe(2);
  expect(host.textContent).toBe('request-after-event');
});
