import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { initialState, type StrategyFormState } from '@/components/hub-cat-editor.model';
import { refreshCatsNow, saveCatOrder } from '@/hooks/useCatData';
import { primeCoCreatorConfigCache } from '@/hooks/useCoCreatorConfig';
import { apiFetch } from '@/utils/api-client';
import {
  createNativeMember,
  type MemberSaveUpdate,
  pickMemberTemplate,
  readMemberClientSettings,
  readMemberRuntimeModels,
  readMemberSettings,
  readNativeMembers,
  removeMember,
  runMemberProviderSetup,
  saveMember,
  saveMemberClientSettings,
  saveMemberOrder,
  saveMemberStrategy,
  saveOwner,
  setMemberAvailable,
} from '../member-actions';
import { fixtureData } from './chat-fixture';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn(), API_URL: 'https://api.test' }));
vi.mock('@/utils/member-save-trace', () => ({
  beginMemberSave: () => ({
    phase: (_name: string, operation: () => Promise<unknown>) => operation(),
    headers: () => ({}),
    fail: vi.fn(),
    finish: vi.fn(),
  }),
}));
const codexBaseline = { sandboxMode: 'workspace-write', approvalPolicy: 'on-request', authMode: 'api_key' } as const;
vi.mock('@/hooks/useCatData', () => ({ refreshCatsNow: vi.fn(), saveCatOrder: vi.fn() }));
vi.mock('@/hooks/useCoCreatorConfig', () => ({ primeCoCreatorConfigCache: vi.fn() }));
const cats = fixtureData().cats.map((cat) => ({
  ...cat,
  name: 'Codex',
  clientId: 'openai',
  carrier: 'app_server' as const,
  roleDescription: 'code',
  personality: '',
  configurationRevision: 'rev-1',
  accountRef: 'oauth-one',
}));
const profiles = [
  {
    id: 'oauth-one',
    name: 'Codex',
    displayName: 'Codex',
    builtin: true,
    authType: 'oauth',
    kind: 'builtin',
    clientId: 'openai',
  },
  {
    id: 'api-one',
    name: 'Key',
    displayName: 'Key',
    builtin: false,
    authType: 'api_key',
    kind: 'api_key',
    clientId: 'anthropic',
  },
];
const template = {
  id: 'maine',
  name: 'Maine',
  avatar: '/avatars/template.png',
  color: { primary: '#556677', secondary: '#ddeeff' },
  roleDescription: 'code',
  personality: 'quiet',
  nickname: 'C',
};
let writes: { path: string; body: Record<string, unknown> }[], rejectWrite: boolean;
beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  writes = [];
  rejectWrite = false;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    const url = String(path);
    if (init?.method && init.method !== 'GET') {
      const body = JSON.parse(String(init.body));
      writes.push({ path: url, body });
      if (rejectWrite)
        return new Response(JSON.stringify({ error: 'owner refused', message: 'owner refused' }), { status: 409 });
      return Response.json(
        url === '/api/config/co-creator' ? { config: { coCreator: body } } : { cat: { ...cats[0], ...body } },
      );
    }
    if (url === '/api/accounts') return Response.json({ providers: profiles, projectPath: '/test/project' });
    if (url === '/api/cats') return Response.json({ cats });
    if (url === '/api/cat-templates') return Response.json({ templates: [template] });
    if (url === '/api/config/session-strategy') return Response.json({ cats: [] });
    if (url === '/api/cats/native-runtimes') return Response.json({ runtimes: [] });
    if (url === '/api/agent-providers') return Response.json({ libraries: [] });
    if (url === '/api/config')
      return Response.json({
        config: {
          cli: { codexSandboxMode: 'workspace-write', codexApprovalPolicy: 'on-request' },
          codexExecution: { authMode: 'api_key' },
        },
        revisions: { 'cli.codexSandboxMode': 'sandbox-1', 'cli.codexApprovalPolicy': 'approval-1' },
      });
    throw new Error('unhandled ' + url);
  });
});
afterEach(() => vi.restoreAllMocks());

it('removes a member through its actual DELETE owner and refreshes cats only after acknowledgement', async () => {
  let finish!: (response: Response) => void;
  vi.mocked(apiFetch).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const removal = removeMember('member/id', 'member-revision');
  expect(apiFetch).toHaveBeenCalledWith(
    '/api/cats/member%2Fid',
    {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 'member-revision' }),
    },
    undefined,
  );
  expect(refreshCatsNow).not.toHaveBeenCalled();
  finish(Response.json({ deleted: true, id: 'member/id', updatedBy: 'owner' }));
  await removal;
  expect(refreshCatsNow).toHaveBeenCalledTimes(1);
  vi.mocked(apiFetch).mockResolvedValueOnce(Response.json({ error: 'Built-in cloud member' }, { status: 409 }));
  await expect(removeMember('cloud', 'cloud-revision')).rejects.toThrow('Built-in cloud member');
  expect(refreshCatsNow).toHaveBeenCalledTimes(1);
});

it('projects actual strategy capability and native launch choices without turning unknown login into configured', async () => {
  const base = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path === '/api/config/session-strategy')
      return Response.json({
        cats: [
          {
            catId: 'codex',
            effective: { strategy: 'hybrid', thresholds: { warn: 70, action: 90 }, hybrid: { maxCompressions: 3 } },
            source: 'runtime_override',
            revision: 'strategy-4',
            changedAt: 4,
            executionStatus: { status: 'degraded', missingCapabilities: ['observesCompression'] },
          },
        ],
      });
    if (path === '/api/cats/native-runtimes')
      return Response.json({
        runtimes: [
          {
            id: 'dsh',
            label: 'DSH',
            clientId: 'acp',
            installed: true,
            models: [],
            acp: { command: '/tools/dsh', startupArgs: ['--profile', 'work profile', 'acp'] },
            readiness: { status: 'unknown', checkedAt: 4 },
            dshDesktop: true,
          },
        ],
      });
    return base(path, init);
  });
  const value = await readMemberSettings();
  expect(value.strategies[0]).toMatchObject({
    id: 'codex',
    form: { strategy: 'hybrid', maxCompressions: '3', revision: 'strategy-4', executionStatus: { status: 'degraded' } },
  });
  expect(value.runtimes.find((runtime) => runtime.id === 'dsh')).toMatchObject({
    readiness: { status: 'unknown' },
    form: {
      configurationSource: 'native_tool',
      acpCommand: '/tools/dsh',
      acpStartupArgs: '--profile "work profile" acp',
    },
  });
});

it('saves strategy intent through its owner, validates thresholds once and returns the confirmed capability', async () => {
  const form: StrategyFormState = {
    strategy: 'hybrid',
    statusStrategy: 'handoff',
    warnThreshold: '70',
    actionThreshold: '90',
    maxCompressions: '3',
    source: 'config_file',
    revision: 'old',
    overrideRevision: 'override-1',
    changedAt: 1,
    executionStatus: { status: 'active', missingCapabilities: [] },
  };
  vi.mocked(apiFetch).mockResolvedValueOnce(
    Response.json({
      catId: 'codex',
      effective: { strategy: 'hybrid', thresholds: { warn: 70, action: 90 }, hybrid: { maxCompressions: 3 } },
      source: 'runtime_override',
      revision: 'new',
      changedAt: 2,
      executionStatus: { status: 'degraded', missingCapabilities: ['observesCompression'] },
    }),
  );
  expect(await saveMemberStrategy('codex', form)).toMatchObject({
    statusStrategy: 'hybrid',
    revision: 'new',
    executionStatus: { status: 'degraded' },
  });
  expect(apiFetch).toHaveBeenLastCalledWith(
    '/api/config/session-strategy/codex',
    expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({
        strategy: 'hybrid',
        thresholds: { warn: 70, action: 90 },
        hybrid: { maxCompressions: 3 },
        expectedRevision: 'override-1',
      }),
    }),
    undefined,
  );
  vi.mocked(apiFetch).mockClear();
  await expect(saveMemberStrategy('codex', { ...form, warnThreshold: '95' })).rejects.toThrow('Warn Threshold');
  expect(apiFetch).not.toHaveBeenCalled();
  vi.mocked(apiFetch).mockResolvedValueOnce(Response.json({ error: 'strategy owner refused' }, { status: 409 }));
  await expect(saveMemberStrategy('codex', form)).rejects.toThrow('strategy owner refused');
});

it('keeps DSH inspect and test explicit and quotes the prepared launch using the original argument serializer', async () => {
  const inspection = { revision: 'owner-revision', profiles: ['acp'], active: {}, source: { providers: [] } };
  vi.mocked(apiFetch).mockResolvedValueOnce(Response.json(inspection));
  expect(await runMemberProviderSetup('inspect', '{"runtimeId":"dsh","sourceProfile":"acp"}')).toEqual(inspection);
  expect(apiFetch).toHaveBeenCalledOnce();
  vi.mocked(apiFetch).mockResolvedValueOnce(
    Response.json({ status: 'live', models: [{ value: 'owner-model', label: 'Owner model' }] }),
  );
  expect(await readMemberRuntimeModels('{"runtimeId":"dsh","catId":"codex","model":"owner-model"}')).toMatchObject({
    status: 'live',
    models: [{ value: 'owner-model' }],
  });
  vi.mocked(apiFetch).mockResolvedValueOnce(
    Response.json({ id: 'owner-receipt', command: 'dsh', startupArgs: ['--profile', 'work profile', 'acp'] }),
  );
  expect(await runMemberProviderSetup('prepare', '{"revision":"owner-revision"}')).toMatchObject({
    id: 'owner-receipt',
    launch: { acpCommand: 'dsh', acpStartupArgs: '--profile "work profile" acp', defaultModel: '', cliEffort: '' },
  });
  vi.mocked(apiFetch).mockResolvedValueOnce(Response.json({ ok: true }));
  await runMemberProviderSetup('test', '{"id":"owner-receipt"}');
  expect(apiFetch).toHaveBeenLastCalledWith(
    '/api/cats/dsh-setup/test',
    expect.objectContaining({ method: 'POST', body: '{"id":"owner-receipt"}' }),
  );
  vi.mocked(apiFetch).mockResolvedValueOnce(
    Response.json({ error: 'dsh_setup_profile_required', profiles: ['work'] }, { status: 409 }),
  );
  await expect(runMemberProviderSetup('inspect', '{"runtimeId":"dsh","sourceProfile":"acp"}')).rejects.toMatchObject({
    message: 'dsh_setup_profile_required',
    profiles: ['work'],
  });
});

it('uses native readiness and preserves the original create body and idempotency key after a lost reply', async () => {
  const runtimes = [
    {
      id: 'codex',
      label: 'Codex',
      clientId: 'openai',
      installed: true,
      models: [],
      readiness: { status: 'configured', checkedAt: 1 },
    },
    {
      id: 'claude',
      label: 'Claude',
      clientId: 'anthropic',
      installed: true,
      models: [],
      readiness: { status: 'login_required', checkedAt: 1 },
    },
  ];
  let attempts = 0;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (init?.method === 'POST') {
      attempts++;
      return attempts === 1
        ? Response.json({ error: 'reply uncertain' }, { status: 503 })
        : Response.json({ cat: { ...cats[0], id: 'native-codex' } });
    }
    if (String(path).startsWith('/api/cats/native-runtimes')) return Response.json({ runtimes });
    if (path === '/api/accounts') return Response.json({ providers: profiles, projectPath: '/test/project' });
    if (path === '/api/cat-templates') return Response.json({ templates: [template] });
    if (path === '/api/cats') return Response.json({ cats: [] });
    throw new Error(String(path));
  });
  const partners = await readNativeMembers('journey-member-settings', true);
  expect(partners.find((partner) => partner.runtime.id === 'claude')).toMatchObject({
    selected: false,
    selectable: false,
  });
  const partner = partners.find((candidate) => candidate.runtime.id === 'codex')!;
  expect(partner.selectable).toBe(true);
  expect(partner.form.accountRef).toBe('');
  await expect(createNativeMember(partner, 'journey-member-settings')).rejects.toThrow('reply uncertain');
  expect(await createNativeMember(partner, 'journey-member-settings')).toMatchObject({ id: 'native-codex' });
  const calls = vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(calls[1]).toEqual(calls[0]);
  expect(calls[1][1]?.headers).toMatchObject({
    'Idempotency-Key': `onboarding:journey-member-settings:cat:${partner.creationRequestKey}`,
  });
  expect(JSON.parse(String(calls[1][1]?.body))).toMatchObject({
    configurationSource: 'native_tool',
    clientId: 'openai',
    defaultModel: '',
  });
  expect(JSON.parse(String(calls[1][1]?.body)).accountRef).toBeUndefined();
  expect(refreshCatsNow).toHaveBeenCalledOnce();
});

it('reads and saves only the library configuration key with the actual plugin lifecycle revision', async () => {
  const profilesValue = JSON.stringify([{ id: 'dsh', name: 'DSH', command: 'dsh', startupArgs: ['acp'] }]);
  const plugin = {
    pluginId: 'clients',
    artifact: 'installed',
    lifecycleRevision: 7,
    configFields: [{ key: 'CLIENTS', kind: 'string', currentValue: profilesValue }],
  };
  vi.mocked(apiFetch).mockImplementation(async () => Response.json({ plugin }));
  const owner = await readMemberClientSettings('clients');
  expect(await saveMemberClientSettings(owner, 'CLIENTS', profilesValue)).toEqual(plugin);
  expect(apiFetch).toHaveBeenCalledWith(
    '/api/plugin-manager/plugins/clients/contributions/configuration',
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ expectedRevision: 7, updates: [{ key: 'CLIENTS', value: profilesValue }] }),
    }),
    undefined,
  );
  vi.mocked(apiFetch).mockClear();
  await expect(
    saveMemberClientSettings(
      owner,
      'CLIENTS',
      JSON.stringify([{ id: 'bad id', name: 'X', command: 'dsh', startupArgs: [] }]),
    ),
  ).rejects.toThrow('客户端 ID');
  expect(apiFetch).not.toHaveBeenCalled();
  vi.mocked(apiFetch).mockResolvedValueOnce(Response.json({ error: 'plugin revision conflict' }, { status: 409 }));
  await expect(saveMemberClientSettings(owner, 'CLIENTS', profilesValue)).rejects.toThrow('plugin revision conflict');
  expect(apiFetch).toHaveBeenCalledOnce();
});

it('permutes only visible member slots and awaits the existing ordering owner', async () => {
  const order = ['a', 'hidden-a', 'b', 'hidden-b', 'c'].map((id) => ({ ...cats[0], id }));
  let done!: () => void;
  vi.mocked(saveCatOrder).mockReturnValue(
    new Promise<void>((resolve) => {
      done = resolve;
    }),
  );
  let resolved = false;
  const save = saveMemberOrder(['c', 'a', 'b'], order).then(() => {
    resolved = true;
  });
  expect(saveCatOrder).toHaveBeenCalledWith(['c', 'hidden-a', 'a', 'hidden-b', 'b']);
  expect(resolved).toBe(false);
  done();
  await save;
  expect(resolved).toBe(true);
  await expect(saveMemberOrder(['a', 'a'], order)).rejects.toThrow('members.loadError');
});

it('uses real templates without changing an uploaded avatar, including blank', async () => {
  const form = { ...initialState(), avatar: '/uploads/avatar.png' };
  const chosen = await pickMemberTemplate('maine', form, cats);
  expect(chosen).toMatchObject({
    name: 'Maine',
    clientId: 'openai',
    avatar: form.avatar,
    defaultModel: '',
    accountRef: '',
  });
  expect(await pickMemberTemplate('blank', chosen, cats)).toMatchObject({ name: '', avatar: form.avatar });
  await expect(pickMemberTemplate('missing', form, cats)).rejects.toThrow('memberNew.templatesError');
});

it('derives account options from real account families and exposes only actual carrier choices', async () => {
  const data = await readMemberSettings();
  expect(data.clients.find((client) => client.id === 'openai')?.accounts).toEqual(['oauth-one', 'api-one']);
  expect(data.clients.find((client) => client.id === 'openai')?.carriers).toContainEqual(['app_server', 'App Server']);
  expect(data.templates).toEqual([template]);
  expect(data.clients.find((client) => client.id === 'google')?.acpMaxDefault).toBe(3);
  expect(data.clients.find((client) => client.id === 'acp')?.acpMaxDefault).toBe(20);
});

it('creates the probed AGY member with its chosen model and effort and the current project as a restricted workspace', async () => {
  const read = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) =>
    path === '/api/cats/native-runtimes'
      ? Response.json({
          runtimes: [
            {
              id: 'agy-native',
              label: 'AGY Native',
              clientId: 'google',
              agyCarrier: 'native',
              installed: true,
              models: [],
              readiness: { status: 'unknown' },
            },
          ],
        })
      : path === '/api/cats' && !init?.method
        ? Response.json({ cats: [] })
        : read(path, init),
  );
  const partners = await readNativeMembers('journey', false),
    partner = partners[0];
  expect(partner.selectable).toBe(true);
  expect(partner.form.defaultModel).toBe('');
  partner.form.defaultModel = 'gemini-native';
  partner.form.cliEffort = 'high';
  await createNativeMember(partner, 'journey');
  expect(writes.at(-1)?.body).toMatchObject({
    defaultModel: 'gemini-native',
    cli: { effort: 'high' },
    agyProfile: { carrier: 'native', model: 'gemini-native', autoApprove: false, trustedWorkspaces: ['/test/project'] },
  });
});

it('writes member changes with revision and account-derived service tier, without a credential setting', async () => {
  const cat = cats[0],
    form = { ...initialState(cat), nickname: 'New', codexSpeed: 'fast' as const };
  await saveMember(form, cat, 'rev-1', { sandboxMode: 'read-only', approvalPolicy: 'never', baseline: codexBaseline });
  expect(writes.find((write) => write.path === '/api/cats/codex')).toMatchObject({
    path: '/api/cats/codex',
    body: { nickname: 'New', expectedRevision: 'rev-1', cli: { serviceTier: 'fast' } },
  });
  expect(writes.filter((write) => write.path === '/api/config')).toEqual([
    { path: '/api/config', body: { key: 'cli.codexSandboxMode', value: 'read-only', expectedRevision: 'sandbox-1' } },
    { path: '/api/config', body: { key: 'cli.codexApprovalPolicy', value: 'never', expectedRevision: 'approval-1' } },
  ]);
  expect(refreshCatsNow).toHaveBeenCalledOnce();
  writes = [];
  await expect(saveMember(form, cat, 'old')).rejects.toThrow('runtime.readError');
  expect(writes).toEqual([]);
});

it('does not advance the member revision when client settings fail, and does not rewrite the member for client-only changes', async () => {
  const cat = cats[0],
    form = initialState(cat);
  rejectWrite = true;
  await expect(
    saveMember({ ...form, nickname: 'New' }, cat, 'rev-1', {
      sandboxMode: 'read-only',
      approvalPolicy: 'never',
      baseline: codexBaseline,
    }),
  ).rejects.toThrow('owner refused');
  expect(writes.map((row) => row.path)).toEqual(['/api/cats/codex']);
  expect(refreshCatsNow).not.toHaveBeenCalled();
  rejectWrite = false;
  writes = [];
  await saveMember(form, cat, 'rev-1', { sandboxMode: 'read-only', approvalPolicy: 'never', baseline: codexBaseline });
  expect(writes.every((row) => row.path === '/api/config')).toBe(true);
  expect(refreshCatsNow).toHaveBeenCalledOnce();
});

it('retains an acknowledged member revision when an attached config write fails, then retries only that stage', async () => {
  const original = cats[0],
    form = { ...initialState(original), nickname: 'Saved member' };
  const current = { ...original, nickname: 'Saved member', configurationRevision: 'rev-2' };
  const base = vi.mocked(apiFetch).getMockImplementation()!;
  let rejectConfig = true;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (init?.method === 'PATCH' && path === '/api/cats/codex') return Response.json({ cat: current });
    if (init?.method === 'PATCH' && path === '/api/config')
      return rejectConfig ? Response.json({ error: 'settings refused' }, { status: 503 }) : Response.json({ ok: true });
    return base(path, init);
  });
  const shared = { sandboxMode: 'read-only', approvalPolicy: 'never', baseline: codexBaseline } as const;
  await expect(saveMember(form, original, 'rev-1', shared)).rejects.toThrow('settings refused');
  expect(refreshCatsNow).toHaveBeenCalledOnce();
  rejectConfig = false;
  await expect(saveMember(form, original, 'rev-2', shared)).resolves.toMatchObject({ configurationRevision: 'rev-2' });
  const memberWrites = vi
    .mocked(apiFetch)
    .mock.calls.filter(([path, init]) => path === '/api/cats/codex' && init?.method === 'PATCH');
  expect(memberWrites).toHaveLength(1);
  expect(JSON.parse(String(memberWrites[0][1]?.body))).toMatchObject({
    expectedRevision: 'rev-1',
    nickname: 'Saved member',
  });
  expect(refreshCatsNow).toHaveBeenCalledTimes(2);
});

it('checks an uncertain create before retrying and adopts its original member without creating another one', async () => {
  const form = { ...initialState(cats[0]), catId: 'created-member' },
    accepted = { ...cats[0], id: form.catId, configurationRevision: 'created-revision' },
    updates: MemberSaveUpdate[] = [],
    base = vi.mocked(apiFetch).getMockImplementation()!;
  let readable = false;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path === '/api/cats' && init?.method === 'POST') throw new Error('reply lost');
    if (path === '/api/cats') {
      if (!readable) throw new Error('read unavailable');
      return Response.json({ cats: [accepted] });
    }
    return base(path, init);
  });
  const changed = (update: MemberSaveUpdate) => updates.push(update);
  await expect(saveMember(form, null, undefined, undefined, changed)).rejects.toThrow('reply lost');
  expect(updates.at(-1)).toMatchObject({
    state: 'idle',
    error: 'member_write_unconfirmed',
    draft: { pendingWrite: { catId: form.catId, create: true } },
  });
  updates.length = 0;
  await expect(saveMember(form, null, undefined, undefined, changed)).rejects.toThrow('read unavailable');
  expect(updates.map((update) => update.state)).toEqual(['checking', 'idle']);
  expect(updates.at(-1)?.error).toBe('member_write_unavailable');
  readable = true;
  updates.length = 0;
  await expect(saveMember(form, null, undefined, undefined, changed)).resolves.toEqual(accepted);
  expect(updates[0].state).toBe('checking');
  expect(updates.at(-1)).toMatchObject({ state: 'idle', error: '', draft: { baseline: accepted } });
  expect(updates.at(-1)?.draft.pendingWrite).toBeUndefined();
  expect(
    vi.mocked(apiFetch).mock.calls.filter(([path, init]) => path === '/api/cats' && init?.method === 'POST'),
  ).toHaveLength(1);
  expect(refreshCatsNow).toHaveBeenCalledOnce();
  expect(sessionStorage.length).toBe(0);
});

it('keeps failed owner writes failed without publishing success, and creates via the real endpoint', async () => {
  const form = { ...initialState(cats[0]), catId: 'new-member' };
  rejectWrite = true;
  await expect(saveMember(form, null, undefined)).rejects.toThrow('owner refused');
  expect(refreshCatsNow).not.toHaveBeenCalled();
  rejectWrite = false;
  await saveMember(form, null, undefined);
  expect(writes.at(-1)).toMatchObject({ path: '/api/cats', body: { catId: 'new-member' } });
});

it('uses the co-creator receipt and preserves the owner secondary color without a second control', async () => {
  const owner = {
    name: 'Owner',
    aliases: ['O'],
    mentionPatterns: ['@o'],
    avatar: '/uploads/o.png',
    color: { primary: '#112233', secondary: '#aabbcc' },
  };
  await saveOwner(owner);
  expect(writes[0]).toEqual({ path: '/api/config/co-creator', body: owner });
  expect(primeCoCreatorConfigCache).toHaveBeenCalledWith(owner);
  await setMemberAvailable(cats[0], false);
  expect(writes[1]).toEqual({ path: '/api/cats/codex', body: { available: false, expectedRevision: 'rev-1' } });
});
