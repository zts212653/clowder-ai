import { buildPreviewGatewayUrl } from '@cat-cafe/shared';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { previewVisiblePageAdmissionController as admission } from '@/lib/preview-visible-page-admission-controller';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { usePreviewBindings } from '../usePreviewBindings';
import { fixtureData } from './chat-fixture';
import { act, cleanup, renderHook, waitFor } from './hook-host';
import { useOwnerProjection } from './owner-console';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn(), API_URL: 'https://api.test' }));
vi.mock('@/components/workspace/useHmrStatus', () => ({ useHmrStatus: () => 'connected' }));
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
beforeEach(() => {
  vi.resetAllMocks();
  useChatStore.setState({
    currentThreadId: 'pdl-test',
    workspacePreview: { port: 3011, path: '/owner' },
    pendingPreviewAutoOpen: null,
  });
});
afterEach(async () => {
  const pending = admission.getSnapshot();
  if (pending) admission.fail(pending.eventId, 'visible_page_superseded');
  await cleanup();
  document.querySelectorAll('iframe').forEach((frame) => frame.remove());
});

it('pushes discovered services for the selected worktree and opens one through the real port authorization', async () => {
  useChatStore.setState({ workspacePreview: undefined });
  let allowed = false;
  vi.mocked(apiFetch).mockImplementation(async (raw, init) => {
    const url = new URL(String(raw), 'https://api.test');
    if (url.pathname === '/api/preview/status') return response({ available: true, gatewayPort: 4111 });
    if (url.pathname === '/api/preview/discovered') {
      expect(url.searchParams.get('worktreeId')).toBe('wt');
      return response([{ port: 3012, framework: 'Vite', reachable: true, worktreeId: 'wt', discoveredAt: 1 }]);
    }
    if (url.pathname === '/api/preview/open') return response({ allowed, reason: 'port_refused' });
    if (url.pathname === '/api/preview/target-health') return response({ reachable: true });
    throw new Error(String(raw) + String(init?.method));
  });
  const data = fixtureData();
  const { result } = renderHook(() => useOwnerProjection('preview', usePreviewBindings(data, 'wt', true), { data }));
  await waitFor(() =>
    expect(result.current.project().preview.discovered).toEqual([
      { port: 3012, framework: 'Vite', reachable: true, worktreeId: 'wt', discoveredAt: 1 },
    ]),
  );
  await act(async () => {
    await expect(result.current.action('pvDiscovered', { port: '3012' })).rejects.toThrow('port_refused');
  });
  expect(result.current.project().preview.page).toBe(false);
  allowed = true;
  await act(() => result.current.action('pvDiscovered', { port: '3012' }));
  await waitFor(() => expect(result.current.project().preview).toMatchObject({ host: 'localhost', port: 3012 }));
  expect(result.current.project().preview.page).toBe(true);
  expect(apiFetch).toHaveBeenCalledWith(
    '/api/preview/open',
    expect.objectContaining({ method: 'POST', body: JSON.stringify({ port: 3012 }) }),
    undefined,
  );
});
it('binds a real gateway frame, admits only its visible matching proof, and waits for screenshot persistence', async () => {
  let acknowledge!: () => void;
  const saves: unknown[] = [];
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path === '/api/preview/status') return response({ available: true, gatewayPort: 4111 });
    if (String(path).startsWith('/api/preview/target-health')) return response({ reachable: true });
    if (path === '/api/preview/screenshot') {
      saves.push(JSON.parse(String(init?.body)));
      await new Promise<void>((r) => {
        acknowledge = r;
      });
      return response({ url: '/uploads/owner-shot.png' });
    }
    throw new Error(String(path));
  });
  const data = fixtureData();
  const { result } = renderHook(() =>
    useOwnerProjection('preview', usePreviewBindings(data, undefined, true), { data }),
  );
  const src = buildPreviewGatewayUrl(4111, 3011, '/owner');
  await waitFor(() => expect(result.current.project().preview.src).toBe(src));
  const frame = document.createElement('iframe');
  frame.src = src;
  document.body.append(frame);
  const post = vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(() => {});
  await act(() => result.current.action('previewFrame', {}, frame));
  await act(() => frame.dispatchEvent(new Event('load')));
  let proof!: ReturnType<typeof admission.begin>;
  await act(() => {
    proof = admission.begin({
      eventId: 'owner-proof',
      port: 3011,
      path: '/owner',
      targetOrigin: new URL(src).origin,
      admission: { expectedClientRevision: 'a'.repeat(40), requiredDom: [] },
    });
  });
  expect(post).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'visible-page-admission-request', eventId: 'owner-proof' }),
    new URL(src).origin,
  );
  const message = (data: object, origin = new URL(src).origin, source = frame.contentWindow) => ({
    event: new MessageEvent('message', {
      data: { source: 'cat-cafe-bridge', ...data },
      origin,
      source,
    }) as unknown as string,
  });
  const attestation = {
    eventId: 'owner-proof',
    targetPort: 3011,
    targetOrigin: new URL(src).origin,
    targetPath: '/owner',
    clientRevision: 'a'.repeat(40),
    dom: [],
    forbiddenTextMatches: [],
  };
  await act(() =>
    result.current.action(
      'pvFrameMessage',
      message({ type: 'visible-page-attestation', attestation }, 'https://untrusted.test'),
      frame,
    ),
  );
  expect(admission.getSnapshot()?.eventId).toBe('owner-proof');
  await act(() =>
    result.current.action('pvFrameMessage', message({ type: 'visible-page-attestation', attestation }), frame),
  );
  expect((await proof).status).toBe('attested');
  await act(() =>
    result.current.action(
      'pvFrameMessage',
      message({ type: 'console', level: 'error', args: ['Owner console'], timestamp: 1000 }),
      frame,
    ),
  );
  expect(result.current.project().preview.log.entries[0].args[0]).toBe('Owner console');
  expect(result.current.project().preview.consoleOpen).toBe(true);
  let shot!: Promise<boolean>;
  await act(() => {
    shot = result.current.action('pvShot', {});
  });
  expect(post).toHaveBeenCalledWith({ type: 'screenshot-request', source: 'cat-cafe-preview' }, new URL(src).origin);
  await act(() =>
    result.current.action(
      'pvFrameMessage',
      message({ type: 'screenshot-result', dataUrl: 'forged' }, 'https://untrusted.test'),
      frame,
    ),
  );
  expect(saves).toEqual([]);
  let incoming!: Promise<boolean>;
  await act(() => {
    incoming = result.current.action(
      'pvFrameMessage',
      message({ type: 'screenshot-result', dataUrl: 'data:image/png;base64,T1dORVI=' }),
      frame,
    );
  });
  expect(saves).toEqual([{ dataUrl: 'data:image/png;base64,T1dORVI=' }]);
  expect(result.current.project().previewReceipt).toBeNull();
  expect(result.current.project().preview.noShot).toBe(true);
  await act(async () => {
    acknowledge();
    await incoming;
    await shot;
  });
  expect(result.current.project().previewReceipt).toBe('/uploads/owner-shot.png');
  expect(result.current.project().preview.noShot).toBe(false);
});

it('keeps a denied navigation out of the frame and does not close the server preview on unmount', async () => {
  const writes: string[] = [];
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (init?.method) {
      writes.push(String(path));
      return response({ allowed: false, reason: 'Owner denied port' });
    }
    if (path === '/api/preview/status') return response({ available: true, gatewayPort: 4111 });
    return response({ reachable: true });
  });
  const data = fixtureData();
  const { result } = renderHook(() =>
    useOwnerProjection('preview', usePreviewBindings(data, undefined, true), { data }),
  );
  await waitFor(() => expect(result.current.project().preview.src).toBe(buildPreviewGatewayUrl(4111, 3011, '/owner')));
  await act(async () => {
    await expect(result.current.action('pvGo', { v: 'localhost:6006/new' })).rejects.toThrow('Owner denied port');
  });
  expect(useChatStore.getState().workspacePreview).toEqual({ port: 3011, path: '/owner' });
  expect(result.current.project().preview.src).toBe(buildPreviewGatewayUrl(4111, 3011, '/owner'));
  await cleanup();
  expect(writes).toEqual(['/api/preview/open']);
});

it('accepts an owner auto-open without another open write and keeps a blank tab in the thread reading state', async () => {
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    expect(init?.method).toBeUndefined();
    return String(path) === '/api/preview/status'
      ? response({ available: true, gatewayPort: 4111 })
      : response({ reachable: true });
  });
  useChatStore.getState().setWorkspacePreview({ port: 3011, path: '/owner' });
  const data = fixtureData();
  const { result } = renderHook(() =>
    useOwnerProjection('preview', usePreviewBindings(data, undefined, true), { data }),
  );
  await waitFor(() => expect(result.current.project().preview.src).toBe(buildPreviewGatewayUrl(4111, 3011, '/owner')));
  await act(() => result.current.action('pvTabAdd', {}));
  expect(result.current.project().preview.src).toBe('');
  expect(result.current.project().preview.page).toBe(false);
  expect(result.current.project().preview.consoleOpen).toBe(false);
  expect(useChatStore.getState().workspacePreview).toEqual({ port: undefined, path: '/' });
});
