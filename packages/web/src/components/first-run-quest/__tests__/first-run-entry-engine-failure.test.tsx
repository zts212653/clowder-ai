import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useGuideEngine } from '@/hooks/useGuideEngine';
import { useChatStore } from '@/stores/chatStore';
import { useGuideStore } from '@/stores/guideStore';
import { apiFetch } from '@/utils/api-client';
import { FirstRunEntryReminder } from '../FirstRunEntryReminder';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
const flow = {
  id: 'first-run-entry',
  name: '入口',
  nonBlocking: true,
  steps: [{ id: 'settings', target: 'hub.trigger', tips: '成员与账号', advance: 'next' }],
};
let root: Root, host: HTMLDivElement;
function Probe() {
  useGuideEngine();
  return <FirstRunEntryReminder enabled threadId="entry-fixture" />;
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  useChatStore.setState({ currentThreadId: 'entry-fixture' });
  useGuideStore.setState({
    session: null,
    startFailure: null,
    pendingStart: null,
    completedGuides: new Set(),
    completionPersisted: false,
  });
  vi.mocked(apiFetch).mockReset();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useGuideStore.setState({ session: null, startFailure: null, pendingStart: null, completedGuides: new Set() });
});
it.each([
  'http',
  'empty',
  'network',
])('exposes a recoverable flow load failure without recording completion (%s)', async (failure) => {
  let fail = true;
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    if (path === '/api/config/onboarding/entry') return Response.json({ status: 'pending' });
    if (path === '/api/guide-flows/first-run-entry') {
      if (!fail) return Response.json(flow);
      if (failure === 'network') throw Error('fixture connection lost');
      return Response.json({ steps: [] }, { status: failure === 'http' ? 503 : 200 });
    }
    if (path === '/api/guide-actions/start') return Response.json({ ok: true });
    throw Error(`Unexpected ${path}`);
  });
  await act(async () => root.render(<Probe />));
  expect(host.textContent).toContain('可以直接开始对话');
  expect(useGuideStore.getState().completedGuides.size).toBe(0);
  expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
  fail = false;
  await act(async () => host.querySelector<HTMLButtonElement>('button')?.click());
  expect(useGuideStore.getState().session?.flow.id).toBe('first-run-entry');
  expect(host.textContent).toBe('');
});
it('times out a hung flow fetch and permits a fresh attempt', async () => {
  vi.useFakeTimers();
  let hang = true;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path === '/api/config/onboarding/entry') return Response.json({ status: 'pending' });
    if (path === '/api/guide-flows/first-run-entry') {
      if (!hang) return Response.json(flow);
      return new Promise((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () => reject(Error('timeout')), { once: true }),
      );
    }
    return Response.json({ ok: true });
  });
  await act(async () => root.render(<Probe />));
  await act(async () => vi.advanceTimersByTimeAsync(10000));
  expect(host.textContent).toContain('可以直接开始对话');
  hang = false;
  await act(async () => host.querySelector<HTMLButtonElement>('button')?.click());
  expect(useGuideStore.getState().session?.flow.id).toBe('first-run-entry');
});

it('does not replace a newer guide when an older definition finishes late', async () => {
  let release!: (value: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    release = resolve;
  });
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    if (path === '/api/config/onboarding/entry') return Response.json({ status: 'pending' });
    if (path === '/api/guide-flows/first-run-entry') return pending;
    if (path === '/api/guide-flows/add-member') return Response.json({ ...flow, id: 'add-member' });
    return Response.json({ ok: true });
  });
  await act(async () => root.render(<Probe />));
  await act(async () =>
    useGuideStore.getState().reduceServerEvent({ action: 'start', guideId: 'add-member', threadId: 'entry-fixture' }),
  );
  expect(useGuideStore.getState().session?.flow.id).toBe('add-member');
  await act(async () => {
    release(Response.json(flow));
    await pending;
  });
  expect(useGuideStore.getState().session?.flow.id).toBe('add-member');
  expect(vi.mocked(apiFetch).mock.calls.filter(([path]) => path === '/api/guide-actions/start')).toHaveLength(1);
});

it('does not show a stale failure after navigation or a newer failed start', async () => {
  let release!: (value: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    release = resolve;
  });
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    if (path === '/api/config/onboarding/entry') return Response.json({ status: 'pending' });
    if (path === '/api/guide-flows/first-run-entry') return pending;
    return Response.json({}, { status: 503 });
  });
  await act(async () => root.render(<Probe />));
  await act(async () =>
    useGuideStore.getState().reduceServerEvent({ action: 'start', guideId: 'add-member', threadId: 'entry-fixture' }),
  );
  expect(useGuideStore.getState().startFailure?.guideId).toBe('add-member');
  await act(async () => {
    release(Response.json({}, { status: 503 }));
    await pending;
  });
  expect(useGuideStore.getState().startFailure?.guideId).toBe('add-member');
  expect(host.textContent).toBe('');
});
