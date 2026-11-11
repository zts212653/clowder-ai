import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { uploadAvatarAsset } from '@/components/hub-cat-editor.client';
import { refreshCatsNow } from '@/hooks/useCatData';
import { apiFetch } from '@/utils/api-client';
import { readMemberCanon, saveMemberCanon } from '../member-actions';
import {
  readPushClient,
  removeMcp,
  resetInjectionSegment,
  saveAccount,
  saveCapability,
  saveInjectionSegment,
  saveMountRules,
  saveThreadEffort,
  saveThreadGoal,
  saveThreadSpeed,
  subscribePush,
  unsubscribePush,
} from '../settings-actions';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('@/hooks/useCatData', () => ({ refreshCatsNow: vi.fn() }));
vi.mock('@/components/hub-cat-editor.client', () => ({ uploadAvatarAsset: vi.fn() }));

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.catCafePwaRetirement;
});
it('joins all canon pages with actual historical records and their replacement reasons without mutating the owner', async () => {
  const readCommands: unknown[] = [];
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    const url = String(path);
    if (url === '/api/works/command') {
      const command = JSON.parse(String(init!.body));
      if (command.command.action === 'list-assets') return Response.json({ items: [], snapshot: 'snapshot-one' });
      readCommands.push(command);
      return Response.json({
        record: {
          indexedVersionRef: 'old-version',
          name: 'First avatar',
          revision: 3,
          version: { recordedAt: '2026-01-01' },
        },
      });
    }
    return Response.json({
      visualAssets: { state: 'selected', indexedVersionRef: 'new-version', bindingRevision: 51 },
      avatar: '/api/cats/member/avatar?bindingRevision=51',
      candidates: url.includes('?')
        ? { items: [] }
        : {
            items: [
              {
                record: {
                  indexedVersionRef: 'new-version',
                  name: 'Current avatar',
                  revision: 2,
                  version: { recordedAt: '2026-02-01' },
                },
              },
            ],
            nextAfter: 50,
          },
      history: url.includes('?')
        ? [{ indexedVersionRef: 'new-version', reason: 'New approved identity' }]
        : [{ indexedVersionRef: 'old-version', reason: 'Initial identity' }],
      ...(!url.includes('?') ? { nextHistoryAfter: 50 } : {}),
    });
  });
  const actual = await readMemberCanon('member', 'thread-one');
  expect(actual).toMatchObject({ bound: true, current: 'new-version', bindingRevision: 51 });
  expect(actual.versions).toContainEqual({
    id: 'old-version',
    label: 'First avatar',
    at: '2026-01-01',
    assetRevision: 3,
    supersededReason: 'New approved identity',
  });
  expect(readCommands).toEqual([
    { threadId: 'thread-one', command: { action: 'read-asset', indexedVersionRef: 'old-version' } },
  ]);
  expect(apiFetch).toHaveBeenCalledWith('/api/cats/member/canon-avatar?after=50&historyAfter=50', undefined, undefined);
  expect(refreshCatsNow).not.toHaveBeenCalled();
});
it('uploads canon bytes first, sends the original binding revision and reason, then refreshes only after acknowledgement', async () => {
  const file = new File(['avatar'], 'avatar.webp', { type: 'image/webp' });
  vi.mocked(uploadAvatarAsset).mockResolvedValue('/uploads/avatar-1-01234567.webp');
  vi.mocked(apiFetch).mockImplementation(async (path, init) =>
    String(path) === '/api/works/command'
      ? Response.json({ items: [], snapshot: 'snapshot-one' })
      : init?.method
        ? Response.json({})
        : Response.json({
            visualAssets: { state: 'selected', indexedVersionRef: 'new-version', bindingRevision: 3 },
            history: [],
            candidates: { items: [] },
          }),
  );
  await saveMemberCanon(
    'member',
    'thread-one',
    JSON.stringify({ operationId: 'operation-one', expectedBindingRevision: 2, reason: 'Approved replacement' }),
    file,
  );
  expect(uploadAvatarAsset).toHaveBeenCalledWith(file);
  const [url, init] = vi.mocked(apiFetch).mock.calls[0];
  expect(url).toBe('/api/cats/member/canon-avatar/upload');
  expect(JSON.parse(String(init!.body))).toEqual({
    operationId: 'operation-one',
    expectedBindingRevision: 2,
    reason: 'Approved replacement',
    uploadUrl: '/uploads/avatar-1-01234567.webp',
  });
  expect(refreshCatsNow).toHaveBeenCalledTimes(1);
});
it('does not refresh or discard a canon selection after an owner revision rejection', async () => {
  vi.mocked(apiFetch).mockResolvedValue(Response.json({ error: 'asset_conflict' }, { status: 409 }));
  await expect(
    saveMemberCanon(
      'member',
      'thread-one',
      JSON.stringify({
        expectedBindingRevision: 2,
        expectedAssetRevision: 3,
        indexedVersionRef: 'chosen-version',
        reason: 'Human choice',
        operationId: 'operation-one',
      }),
    ),
  ).rejects.toThrow('asset_conflict');
  expect(refreshCatsNow).not.toHaveBeenCalled();
  expect(vi.mocked(apiFetch).mock.calls).toHaveLength(1);
});
it.each([
  [
    'account patch',
    () => saveAccount('account/id', '{"displayName":"New note"}'),
    '/api/accounts/account%2Fid',
    'PATCH',
    { displayName: 'New note' },
  ],
  [
    'capability scope',
    () => saveCapability('{"scope":"project","enabled":false}'),
    '/api/capabilities',
    'PATCH',
    { scope: 'project', enabled: false },
  ],
  [
    'mount rules',
    () => saveMountRules('{"scope":"default","rules":{}}'),
    '/api/mount-rules',
    'PUT',
    { scope: 'default', rules: {} },
  ],
  [
    'segment override',
    () => saveInjectionSegment('D1', 'Owner content'),
    '/api/prompt-injection/segment/D1/override',
    'PUT',
    { content: 'Owner content' },
  ],
  ['segment reset', () => resetInjectionSegment('D1'), '/api/prompt-injection/segment/D1/override', 'DELETE', {}],
  [
    'thread effort inherit',
    () => saveThreadEffort('thread/id', 'cat/id', ''),
    '/api/threads/thread%2Fid/members/cat%2Fid/effort',
    'PATCH',
    { effort: null },
  ],
  [
    'thread speed',
    () => saveThreadSpeed('thread-one', 'codex', 'fast'),
    '/api/threads/thread-one/members/codex/speed',
    'PATCH',
    { speed: 'fast' },
  ],
  [
    'thread goal',
    () => saveThreadGoal('thread-one', '{"objective":"Original goal","status":"active","tokenBudget":null}'),
    '/api/threads/thread-one/goal',
    'PUT',
    { objective: 'Original goal', status: 'active', tokenBudget: null },
  ],
] as const)('uses the existing %s writer contract', async (_label, save, url, method, body) => {
  vi.mocked(apiFetch).mockResolvedValue(Response.json({}));
  await save();
  const [actualUrl, init] = vi.mocked(apiFetch).mock.calls[0];
  expect(actualUrl).toBe(url);
  expect(init!.method).toBe(method);
  expect(JSON.parse(String(init!.body))).toEqual(body);
});
it('sends MCP deletion scope as query parameters instead of a DELETE body', async () => {
  vi.mocked(apiFetch).mockResolvedValue(Response.json({}));
  await removeMcp('mcp/id', '{"projectPath":"/workspace/project"}');
  expect(apiFetch).toHaveBeenCalledWith(
    '/api/capabilities/mcp/mcp%2Fid?projectPath=%2Fworkspace%2Fproject',
    { method: 'DELETE' },
    undefined,
  );
});

function browserPush() {
  const subscription = {
      endpoint: 'https://push.test/subscription',
      toJSON: () => ({
        endpoint: 'https://push.test/subscription',
        keys: { p256dh: 'client-public', auth: 'client-auth' },
      }),
      unsubscribe: vi.fn(async () => true),
    },
    registration = {
      pushManager: {
        getSubscription: vi.fn(async () => subscription as typeof subscription | null),
        subscribe: vi.fn<(options: PushSubscriptionOptionsInit) => Promise<typeof subscription>>(
          async () => subscription,
        ),
      },
    },
    serviceWorker = {
      getRegistration: vi.fn(async () => registration as typeof registration | undefined),
      register: vi.fn(),
    },
    permission = vi.fn(async () => 'granted');
  document.documentElement.dataset.catCafePwaRetirement = 'enabled';
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('PushManager', class {});
  vi.stubGlobal('Notification', { permission: 'granted', requestPermission: permission });
  vi.stubGlobal('navigator', { serviceWorker, userAgent: 'Synthetic test browser' });
  return { subscription, registration, serviceWorker, permission };
}
it('reuses the existing worker subscription for registration and cancellation with the actual endpoint', async () => {
  const { subscription, registration, serviceWorker, permission } = browserPush();
  vi.mocked(apiFetch).mockImplementation(async (path) =>
    Response.json(path === '/api/push/vapid-public-key' ? { key: 'AQIDBA', enabled: true } : { status: 'ok' }),
  );
  expect(await readPushClient()).toEqual({
    isSupported: true,
    permission: 'granted',
    isSubscribed: true,
    worker: 'registered',
  });
  expect(apiFetch).not.toHaveBeenCalled();
  expect(permission).not.toHaveBeenCalled();
  await subscribePush();
  const options = registration.pushManager.subscribe.mock.calls[0][0] as PushSubscriptionOptionsInit;
  expect(options.userVisibleOnly).toBe(true);
  expect(Array.from(new Uint8Array(options.applicationServerKey as ArrayBuffer))).toEqual([1, 2, 3, 4]);
  expect(apiFetch).toHaveBeenLastCalledWith(
    '/api/push/subscribe',
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ subscription: subscription.toJSON(), userAgent: 'Synthetic test browser' }),
    }),
    undefined,
  );
  await unsubscribePush();
  expect(subscription.unsubscribe).toHaveBeenCalledOnce();
  expect(apiFetch).toHaveBeenLastCalledWith(
    '/api/push/subscribe',
    expect.objectContaining({ method: 'DELETE', body: JSON.stringify({ endpoint: subscription.endpoint }) }),
    undefined,
  );
  expect(serviceWorker.register).not.toHaveBeenCalled();
});
it('keeps retired PWA subscriptions unavailable and returns a missing existing registration without waiting for a new worker', async () => {
  const { serviceWorker, permission } = browserPush();
  document.documentElement.dataset.catCafePwaRetirement = 'disabled';
  expect(await readPushClient()).toEqual({
    isSupported: false,
    permission: 'granted',
    isSubscribed: false,
    worker: 'disabled',
  });
  await expect(subscribePush()).rejects.toThrow('PWA disabled');
  await expect(unsubscribePush()).rejects.toThrow('PWA disabled');
  expect(serviceWorker.getRegistration).not.toHaveBeenCalled();
  expect(permission).not.toHaveBeenCalled();
  document.documentElement.dataset.catCafePwaRetirement = 'enabled';
  serviceWorker.getRegistration.mockResolvedValue(undefined);
  expect(await readPushClient()).toEqual({
    isSupported: false,
    permission: 'granted',
    isSubscribed: false,
    worker: 'missing',
  });
  expect(serviceWorker.register).not.toHaveBeenCalled();
  expect(apiFetch).not.toHaveBeenCalled();
});
it('removes a browser subscription rejected by its server owner and propagates the actual rejection', async () => {
  const { subscription } = browserPush();
  vi.mocked(apiFetch).mockImplementation(async (path) =>
    path === '/api/push/vapid-public-key'
      ? Response.json({ key: 'AQIDBA', enabled: true })
      : Response.json({ error: 'Subscription rejected' }, { status: 403 }),
  );
  await expect(subscribePush()).rejects.toThrow('Subscription rejected');
  expect(subscription.unsubscribe).toHaveBeenCalledOnce();
});
it('writes null to restore each member setting and preserves the chosen goal member', async () => {
  vi.mocked(apiFetch).mockImplementation(async () => Response.json({}));
  await saveThreadEffort('thread-one', 'opus', '');
  expect(apiFetch).toHaveBeenLastCalledWith(
    '/api/threads/thread-one/members/opus/effort',
    expect.objectContaining({ method: 'PATCH', body: '{"effort":null}' }),
    undefined,
  );
  await saveThreadSpeed('thread-one', 'codex', '');
  expect(apiFetch).toHaveBeenLastCalledWith(
    '/api/threads/thread-one/members/codex/speed',
    expect.objectContaining({ method: 'PATCH', body: '{"speed":null}' }),
    undefined,
  );
  await saveThreadGoal('thread-one', '{"objective":"Goal","status":"active","tokenBudget":null,"catId":"opus"}');
  expect(apiFetch).toHaveBeenLastCalledWith(
    '/api/threads/thread-one/goal',
    expect.objectContaining({
      method: 'PUT',
      body: '{"objective":"Goal","status":"active","tokenBudget":null,"catId":"opus"}',
    }),
    undefined,
  );
});
