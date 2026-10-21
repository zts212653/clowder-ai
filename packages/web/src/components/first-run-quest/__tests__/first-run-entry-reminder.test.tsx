import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useGuideStore } from '@/stores/guideStore';
import { apiFetch } from '@/utils/api-client';
import { FirstRunEntryReminder } from '../FirstRunEntryReminder';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
let host: HTMLDivElement, root: Root;
const path = '/api/config/onboarding/entry';
const json = (status: string, code = 200) => new Response(JSON.stringify({ status }), { status: code });
const flow = {
  id: 'first-run-entry',
  name: '入口提醒',
  nonBlocking: true,
  steps: [{ id: 'settings', target: 'hub.trigger', tips: '成员与账号', advance: 'next' as const }],
};
const render = async (enabled = true) =>
  act(async () => root.render(<FirstRunEntryReminder enabled={enabled} threadId="default" />));
const writes = () => vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'PUT');
const retryButton = () => {
  const button = host.querySelector<HTMLButtonElement>('button');
  if (!button) throw Error('Expected a visible retry button');
  return button;
};
const start = async () =>
  act(() => {
    useGuideStore.getState().clearPendingStart();
    useGuideStore.getState().startGuide(flow, 'default');
  });
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useGuideStore.setState({
    session: null,
    pendingStart: null,
    completedGuides: new Set(),
    completionPersisted: false,
    completionFailed: false,
  });
  vi.mocked(apiFetch).mockReset();
  vi.mocked(apiFetch).mockImplementation(async (_path, init) =>
    json(init?.method === 'PUT' ? JSON.parse(String(init.body)).status : 'pending'),
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  useGuideStore.setState({ session: null, pendingStart: null, completedGuides: new Set() });
});

it.each([
  'not_started',
  'dismissed',
  'completed',
])('does not offer an unarmed or finished personal receipt: %s', async (status) => {
  vi.mocked(apiFetch).mockResolvedValue(json(status));
  await render();
  expect(useGuideStore.getState().pendingStart).toBeNull();
  expect(writes()).toHaveLength(0);
});
it('waits for the main interface eligibility and then uses the existing F155 engine without a modal or focus change', async () => {
  const input = document.createElement('input');
  document.body.append(input);
  input.focus();
  try {
    await render(false);
    expect(apiFetch).not.toHaveBeenCalled();
    await render();
    expect(apiFetch).toHaveBeenCalledWith(path, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(useGuideStore.getState().pendingStart).toEqual({ guideId: 'first-run-entry', threadId: 'default' });
    expect(document.activeElement).toBe(input);
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  } finally {
    input.remove();
  }
});
it('does not replace another guide and starts only after that guide exits', async () => {
  act(() => useGuideStore.getState().startGuide({ ...flow, id: 'other' }, 'default'));
  await render();
  expect(apiFetch).not.toHaveBeenCalled();
  await act(async () => useGuideStore.getState().exitGuide({ recordCompletion: false }));
  expect(useGuideStore.getState().pendingStart?.guideId).toBe('first-run-entry');
});
it('records an explicit dismissal through the same session-owned preference endpoint', async () => {
  await render();
  await start();
  await act(async () => useGuideStore.getState().exitGuide());
  expect(writes()).toHaveLength(1);
  expect(JSON.parse(String(writes()[0][1]?.body))).toEqual({ status: 'dismissed' });
});
it('does not record completion on navigation or an engine error and can re-offer after return', async () => {
  await render();
  await start();
  await render(false);
  await act(async () => useGuideStore.getState().exitGuide({ recordCompletion: false }));
  expect(writes()).toHaveLength(0);
  await render();
  expect(useGuideStore.getState().pendingStart?.guideId).toBe('first-run-entry');
});
it('acknowledges F155 completion only after the personal owner confirms its single write', async () => {
  let release!: (response: Response) => void;
  vi.mocked(apiFetch).mockImplementation(async (_path, init) =>
    init?.method === 'PUT'
      ? new Promise<Response>((resolve) => {
          release = resolve;
        })
      : json('pending'),
  );
  await render();
  await start();
  await act(async () => useGuideStore.getState().advanceStep());
  expect(writes()).toHaveLength(1);
  expect(useGuideStore.getState().completionPersisted).toBe(false);
  await act(async () => release(json('completed')));
  expect(useGuideStore.getState().completionPersisted).toBe(true);
  expect(JSON.parse(String(writes()[0][1]?.body))).toEqual({ status: 'completed' });
  await act(async () => useGuideStore.setState({ startFailure: null }));
  await act(async () => useGuideStore.getState().exitGuide());
  expect(writes()).toHaveLength(1);
});
it('exposes a failed write without a blocking dialog and retries the same dismissal', async () => {
  let fail = true;
  vi.mocked(apiFetch).mockImplementation(async (_path, init) => {
    if (!init?.method) return json('pending');
    return json('dismissed', fail ? 503 : 200);
  });
  await render();
  await start();
  await act(async () => useGuideStore.getState().exitGuide());
  expect(host.textContent).toContain('可以继续对话');
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  fail = false;
  await act(async () => retryButton().click());
  expect(writes()).toHaveLength(2);
  expect(writes().map(([, init]) => JSON.parse(String(init?.body)).status)).toEqual(['dismissed', 'dismissed']);
  expect(host.textContent).toBe('');
});
it('allows read failure recovery without inventing eligibility', async () => {
  vi.mocked(apiFetch).mockResolvedValueOnce(json('error', 503)).mockResolvedValueOnce(json('not_started'));
  await render();
  expect(host.textContent).toContain('可以直接开始对话');
  await act(async () => retryButton().click());
  expect(useGuideStore.getState().pendingStart).toBeNull();
  expect(host.textContent).toBe('');
});
it('ignores a late receipt after eligibility is withdrawn', async () => {
  let resolve!: (response: Response) => void;
  vi.mocked(apiFetch).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await render();
  await render(false);
  await act(async () => resolve(json('pending')));
  expect(useGuideStore.getState().pendingStart).toBeNull();
  expect(writes()).toHaveLength(0);
});

it.each([
  'pending',
  'dismissed',
  'not_started',
])('does not acknowledge a completed intent from an incorrect 200 status: %s', async (status) => {
  vi.mocked(apiFetch).mockImplementation(async (_path, init) => json(init?.method === 'PUT' ? status : 'pending'));
  await render();
  await start();
  await act(async () => useGuideStore.getState().advanceStep());
  expect(useGuideStore.getState().completionPersisted).toBe(false);
  expect(useGuideStore.getState().completionFailed).toBe(true);
  expect(host.textContent).toContain('可以继续对话');
});
