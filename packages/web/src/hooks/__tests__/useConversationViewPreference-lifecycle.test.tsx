import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: api.fetch }));

import { useConversationViewPreference } from '../useConversationViewPreference';

let host: HTMLDivElement;
let root: Root;
function Probe() {
  const view = useConversationViewPreference('thread-lifecycle');
  return (
    <output data-error={view.error ?? ''} data-loading={view.loading}>
      {JSON.stringify(view.snapshot)}
    </output>
  );
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  api.fetch.mockReset();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});
it('aborts a pending view read when its document leaves without reporting an outage', async () => {
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
  let signal: AbortSignal | undefined;
  api.fetch.mockImplementation(
    (_path: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        signal = init.signal ?? undefined;
        signal?.addEventListener('abort', () => reject(new TypeError('Failed to fetch')), { once: true });
      }),
  );
  await act(async () => root.render(<Probe />));
  await act(async () => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  expect(signal?.aborted).toBe(true);
  expect(errorLog).not.toHaveBeenCalled();
  expect(host.querySelector('output')?.dataset.error).toBe('');
});
it('reconciles the canonical preference after a cached document returns', async () => {
  api.fetch.mockResolvedValueOnce(Response.json({ stored: null, effective: { mode: 'group' }, source: 'product' }));
  api.fetch.mockResolvedValueOnce(
    Response.json({ stored: { mode: 'cat', catId: 'pi' }, effective: { mode: 'cat', catId: 'pi' }, source: 'thread' }),
  );
  await act(async () => root.render(<Probe />));
  await act(async () => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  await act(async () => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  expect(api.fetch).toHaveBeenCalledTimes(2);
  expect(host.textContent).toContain('"catId":"pi"');
  expect(host.querySelector('output')?.dataset.loading).toBe('false');
});
it('keeps a real network failure visible', async () => {
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
  api.fetch.mockRejectedValue(new TypeError('Failed to fetch'));
  await act(async () => root.render(<Probe />));
  expect(errorLog).toHaveBeenCalledWith('Failed to load conversation view preference', expect.any(TypeError));
  expect(host.querySelector('output')?.dataset.error).toBe('load');
});
