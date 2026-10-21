import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FirstRunEntryReminder } from '@/components/first-run-quest/FirstRunEntryReminder';
import { GuideOverlay } from '@/components/GuideOverlay';
import { useChatStore } from '@/stores/chatStore';
import { useGuideStore } from '@/stores/guideStore';
import { apiFetch } from '@/utils/api-client';
import { openFirstRunEntryApi } from '../fixtures/first-run-entry-api.mjs';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
const entryPath = '/api/config/onboarding/entry';
let directory: string, host: HTMLDivElement, root: Root;
let api: Awaited<ReturnType<typeof openFirstRunEntryApi>>;
let releaseWrite: (() => void) | undefined;
let writing: Promise<void> | undefined;
const actions: { url: string; status: number }[] = [];
function Probe() {
  return (
    <>
      <button type="button" data-guide-id="hub.trigger">
        Settings
      </button>
      <GuideOverlay />
      <FirstRunEntryReminder enabled threadId="default" />
    </>
  );
}
const resetStore = () =>
  useGuideStore.setState({
    session: null,
    pendingStart: null,
    startFailure: null,
    completionPersisted: false,
    completionFailed: false,
    completedGuides: new Set(),
  });
const receipt = async () => (await api.request(entryPath)).json();
const start = async () => {
  await act(async () => root.render(<Probe />));
  await act(async () => vi.waitFor(() => expect(useGuideStore.getState().session?.flow.id).toBe('first-run-entry')));
};
const complete = async () => act(async () => useGuideStore.getState().advanceStep());
const waitForAcknowledgement = async () =>
  act(async () =>
    vi.waitFor(() => {
      expect(useGuideStore.getState().completionPersisted).toBe(true);
      expect(useGuideStore.getState().completionFailed).toBe(false);
    }),
  );

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  directory = mkdtempSync(path.join(tmpdir(), 'pr1519-personal-entry-'));
  api = await openFirstRunEntryApi(directory, 'owner-proof');
  expect(
    (await api.request(entryPath, { method: 'PUT', body: JSON.stringify({ status: 'pending' }) })).statusCode,
  ).toBe(200);
  actions.length = 0;
  writing = undefined;
  releaseWrite = undefined;
  resetStore();
  useChatStore.setState({ currentThreadId: 'default' });
  vi.mocked(apiFetch)
    .mockReset()
    .mockImplementation(async (url, init) => {
      if (url === entryPath && init?.method === 'PUT' && writing) await writing;
      const response = await api.request(String(url), { method: init?.method, body: init?.body });
      actions.push({ url: String(url), status: response.statusCode });
      return new Response(response.body, {
        status: response.statusCode,
        headers: { 'Content-Type': 'application/json' },
      });
    });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  releaseWrite?.();
  act(() => root.unmount());
  host.remove();
  await api.app.close();
  resetStore();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  expect(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep)).toBe(true);
  expect(path.basename(directory).startsWith('pr1519-personal-entry-')).toBe(true);
  rmSync(directory, { recursive: true, force: true });
});

it('finishes on shared default through the real personal owner without weakening offer guards', async () => {
  const initialSharedState = await api.guideBridge.get('default');
  const rejected = await api.request('/api/guide-actions/start', {
    method: 'POST',
    body: JSON.stringify({ threadId: 'default', guideId: 'first-run-entry' }),
  });
  expect(rejected.statusCode).toBe(409);
  expect(rejected.json().error).toBe('guide_not_offered');
  await start();
  await complete();
  await waitForAcknowledgement();
  expect((await receipt()).status).toBe('completed');
  expect(actions.filter((action) => action.url.startsWith('/api/guide-actions/'))).toEqual([]);
  expect(await api.guideBridge.get('default')).toEqual(initialSharedState);
  await act(async () => useGuideStore.getState().exitGuide());
  expect(vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1);
  await api.app.close();
  api = await openFirstRunEntryApi(directory, 'owner-proof');
  expect((await receipt()).status).toBe('completed');
  const other = await openFirstRunEntryApi(directory, 'another-owner');
  try {
    expect((await other.request(entryPath)).json().status).toBe('not_started');
  } finally {
    await other.app.close();
  }
});

it('waits for the personal write ACK and does not issue a second write after completion closes', async () => {
  writing = new Promise((resolve) => {
    releaseWrite = resolve;
  });
  await start();
  await complete();
  expect(useGuideStore.getState().completionPersisted).toBe(false);
  expect((await receipt()).status).toBe('pending');
  await act(async () => releaseWrite?.());
  await waitForAcknowledgement();
  await act(async () => useGuideStore.getState().exitGuide());
  expect(vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1);
});

it('exposes actual preference corruption without overwriting it, then retries completion through the same owner', async () => {
  await start();
  const before = readFileSync(api.preferencesPath);
  writeFileSync(api.preferencesPath, '{broken');
  await complete();
  await act(async () => vi.waitFor(() => expect(useGuideStore.getState().completionFailed).toBe(true)));
  expect(useGuideStore.getState().completionPersisted).toBe(false);
  expect(readFileSync(api.preferencesPath, 'utf8')).toBe('{broken');
  expect(host.textContent).toContain('可以继续对话');
  expect(useGuideStore.getState().completedGuides.has('default::first-run-entry')).toBe(false);
  writeFileSync(api.preferencesPath, before);
  await act(async () =>
    [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === '重试入口提醒')
      ?.click(),
  );
  await waitForAcknowledgement();
  expect((await receipt()).status).toBe('completed');
});

it.each([
  'active',
  'failed',
])('leaves a different users active shared guide intact when dismissing the personal reminder (%s)', async (phase) => {
  const foreign = {
    v: 1 as const,
    guideId: 'first-run-entry',
    status: 'active' as const,
    userId: 'another-owner',
    offeredAt: 1,
  };
  await api.guideBridge.set('default', foreign);
  const before = await api.guideBridge.get('default');
  await start();
  if (phase === 'failed') {
    const preferences = readFileSync(api.preferencesPath);
    writeFileSync(api.preferencesPath, '{broken');
    await complete();
    await act(async () => vi.waitFor(() => expect(useGuideStore.getState().completionFailed).toBe(true)));
    writeFileSync(api.preferencesPath, preferences);
    await act(async () =>
      [...host.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent === '知道了')
        ?.click(),
    );
    expect((await receipt()).status).toBe('pending');
    await act(async () =>
      [...host.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent === '重试入口提醒')
        ?.click(),
    );
  } else {
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="退出引导"]')?.click());
  }
  await act(async () =>
    vi.waitFor(async () => expect((await receipt()).status).toBe(phase === 'failed' ? 'completed' : 'dismissed')),
  );
  expect(await api.guideBridge.get('default')).toEqual(before);
  expect(actions.filter((action) => action.url.startsWith('/api/guide-actions/'))).toEqual([]);
});

it('does not interpret navigation away from an active reminder as a personal dismissal', async () => {
  await start();
  await act(async () => useChatStore.setState({ currentThreadId: 'another-thread' }));
  expect(useGuideStore.getState().session).toBeNull();
  expect((await receipt()).status).toBe('pending');
  expect(vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(0);
});

it('does not let a late completion ACK confirm a newer guide', async () => {
  writing = new Promise((resolve) => {
    releaseWrite = resolve;
  });
  await start();
  await complete();
  await act(async () =>
    useGuideStore.getState().startGuide(
      {
        id: 'add-member',
        name: 'Another guide',
        steps: [{ id: 'other', target: 'hub.trigger', tips: 'Other', advance: 'next' }],
      },
      'default',
    ),
  );
  await act(async () => releaseWrite?.());
  await act(async () => vi.waitFor(async () => expect((await receipt()).status).toBe('completed')));
  expect(useGuideStore.getState().session?.flow.id).toBe('add-member');
  expect(useGuideStore.getState().completionPersisted).toBe(false);
});

it('keeps completion dominant if the overlay exits while its personal ACK is pending', async () => {
  writing = new Promise((resolve) => {
    releaseWrite = resolve;
  });
  await start();
  await complete();
  await act(async () => useGuideStore.getState().exitGuide());
  await act(async () => releaseWrite?.());
  await act(async () => vi.waitFor(async () => expect((await receipt()).status).toBe('completed')));
  const writes = vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'PUT');
  expect(writes.map(([, init]) => JSON.parse(String(init?.body)).status)).toEqual(['completed']);
});
