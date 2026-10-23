import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { apiFetch } from '@/utils/api-client';
import { getThreadDraft } from '../../thread-drafts';
import { useNativeOnboarding } from '../useNativeOnboarding';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
const catalog = vi.hoisted(() => ({ cats: [] as CatData[] }));
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ cats: catalog.cats, refresh: vi.fn() }) }));
let root: Root, container: HTMLDivElement;
let setup: ReturnType<typeof useNativeOnboarding>;
const onCreated = vi.fn();
function Harness({ mode = 'goal' }: { mode?: 'goal' | 'members' }) {
  setup = useNativeOnboarding(true, onCreated, mode);
  return <p>{setup.loading ? 'loading' : setup.draft?.partners.length}</p>;
}
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const runtimes = [
  { id: 'codex', label: 'Codex', clientId: 'openai', installed: true, models: [] },
  { id: 'claude', label: 'Claude Code', clientId: 'anthropic', installed: true, models: [] },
  {
    id: 'dsh',
    label: 'DSH',
    clientId: 'acp',
    installed: true,
    models: [],
    acp: { command: 'node', startupArgs: ['dsh.js', '--profile', 'acp'] },
  },
];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  catalog.cats = [];
  localStorage.clear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path === '/api/session') return response({ userId: 'owner-a' });
    if (path === '/api/config/onboarding/entry') return response({ status: 'pending' });
    if (String(path).split('?')[0] === '/api/cats/native-runtimes') return response({ runtimes });
    if (path === '/api/cat-templates') return response({ templates: [] });
    if (path === '/api/cats') {
      if (!init?.method) return response({ cats: catalog.cats });
      const payload = JSON.parse(String(init?.body));
      catalog.cats.push({ ...payload, id: payload.catId } as CatData);
      return response(
        { cat: { id: payload.catId, displayName: payload.displayName, mentionPatterns: payload.mentionPatterns } },
        201,
      );
    }
    if (path === '/api/threads') return response({ id: 'ordinary-goal' }, 201);
    throw new Error(`unexpected path ${path}`);
  });
});

it('creates the detected team with one confirmation without creating a conversation', async () => {
  await act(async () => root.render(<Harness mode="members" />));
  expect(setup.draft?.partners.filter((p) => p.selected)).toHaveLength(3);
  await act(async () => setup.patch({ goal: '' }));
  await act(async () => setup.start());
  const writes = vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(writes.map(([path]) => path)).toEqual(['/api/cats', '/api/cats', '/api/cats']);
  const calls = vi.mocked(apiFetch).mock.calls;
  const reminder = calls.findIndex(([path, init]) => path === '/api/config/onboarding/entry' && init?.method === 'PUT');
  expect(reminder).toBeGreaterThanOrEqual(0);
  expect(reminder).toBeLessThan(calls.findIndex(([path, init]) => path === '/api/cats' && init?.method === 'POST'));
  expect(JSON.parse(String(calls[reminder][1]?.body))).toEqual({ status: 'pending' });
  expect(onCreated).toHaveBeenCalledOnce();
});

it('creates both colliding ACP profiles and restores each exact draft after rediscovery', async () => {
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  const peers = ['1e1unfl', 'hlxo45'].map((profile) => ({
    ...runtimes[2],
    id: `dsh-${profile}`,
    acp: { command: 'dsh', startupArgs: ['--profile', profile], transport: 'stdio' },
  }));
  vi.mocked(apiFetch).mockImplementation(async (path, init) =>
    String(path).split('?')[0] === '/api/cats/native-runtimes' ? response({ runtimes: peers }) : original(path, init),
  );
  await act(async () => root.render(<Harness mode="members" />));
  const ids = setup.draft!.partners.map((p) => p.form.catId);
  await act(async () =>
    setup.patchPartner(setup.draft!.partners[0].id, {
      form: { ...setup.draft!.partners[0].form, nickname: 'profile one' },
    }),
  );
  await act(async () => setup.reload());
  expect(setup.draft!.partners.map((p) => p.form.catId)).toEqual(ids);
  expect(setup.draft!.partners[0].form.nickname).toBe('profile one');
  await act(async () => setup.start());
  const writes = vi
    .mocked(apiFetch)
    .mock.calls.filter(([path, init]) => path === '/api/cats' && init?.method === 'POST');
  expect(writes).toHaveLength(2);
  expect(writes[0][1]?.headers).not.toEqual(writes[1][1]?.headers);
  expect(writes.map(([, init]) => JSON.parse(String(init?.body)).acp.startupArgs[1])).toEqual(['1e1unfl', 'hlxo45']);
});

it('does not reuse a removed existing member from a stale local draft', async () => {
  catalog.cats = [
    {
      id: 'removed-codex',
      carrier: 'app_server',
      displayName: 'Old partner',
      clientId: 'openai',
      configurationSource: 'native_tool',
      defaultModel: '',
      avatar: '',
      color: { primary: '#123456', secondary: '#abcdef' },
      roleDescription: '',
      personality: '',
      mentionPatterns: ['@old'],
    },
  ];
  await act(async () => root.render(<Harness mode="members" />));
  await act(async () => {
    for (const p of setup.draft!.partners.slice(1)) setup.patchPartner(p.id, { selected: false });
  });
  await act(async () => setup.start());
  catalog.cats = [];
  vi.mocked(apiFetch).mockClear();
  onCreated.mockClear();
  await act(async () => setup.reload());
  expect(setup.draft?.partners[0].existingId).toBeUndefined();
  expect(setup.draft?.partners[0].missingExisting).toBe(true);
  await act(async () => setup.start());
  const writes = vi
    .mocked(apiFetch)
    .mock.calls.filter(([path, init]) => path === '/api/cats' && init?.method === 'POST');
  expect(writes).toHaveLength(1);
  expect(JSON.parse(String(writes[0][1]?.body)).catId).toBe('removed-codex');
  expect(onCreated).toHaveBeenCalledOnce();
});

it('repairs a legacy detection draft when the member is no longer in the roster', async () => {
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) =>
    String(path).split('?')[0] === '/api/cats/native-runtimes'
      ? response({ runtimes: [runtimes[2]] })
      : original(path, init),
  );
  await act(async () => root.render(<Harness mode="members" />));
  const fresh = setup.draft!.partners[0];
  const legacyForm = {
    ...fresh.form,
    name: 'DSH 伙伴',
    displayName: 'DSH 伙伴',
    nickname: '深深',
    avatar: '/avatars/family/kimi.png',
    roleDescription: '共创与推理伙伴，负责分析问题、编码实现和交叉验证',
    personality: '细心务实，先理清问题，再用可验证的结果交付',
    teamStrengths: '问题分析、编码、交叉验证',
  };
  localStorage.setItem(
    'cat-cafe:native-team-setup:v2:owner-a',
    JSON.stringify({
      version: 2,
      idScheme: 'short-v1',
      journeyId: 'legacy-journey',
      initialRosterEmpty: true,
      partners: [{ ...fresh, creationRequestKey: 'acp-old-request', form: legacyForm }],
      goal: '',
      lead: fresh.id,
      created: {},
    }),
  );
  catalog.cats = [];
  act(() => root.unmount());
  root = createRoot(container);
  await act(async () => root.render(<Harness mode="members" />));
  const partner = setup.draft!.partners[0];
  expect(partner.form.displayName).toBe('小鲸鱼');
  expect(partner.form.nickname).toBe('鲸鲸');
  expect(partner.form.avatar).toBe('/avatars/family/dsh.png');
  expect(partner.creationRequestKey).not.toBe('acp-old-request');
});

it('retains a legacy draft ID and custom identity when rediscovery recomputes recommendations', async () => {
  await act(async () => root.render(<Harness mode="members" />));
  const saved = JSON.parse(localStorage.getItem('cat-cafe:native-team-setup:v2:owner-a')!);
  saved.partners[0].form.catId = 'partner-legacy-long-journey-codex';
  saved.partners[0].form.cliConfigArgs = ['--settings', '/custom.json'];
  saved.partners[0].form.accountRef = 'custom-account';
  localStorage.setItem('cat-cafe:native-team-setup:v2:owner-a', JSON.stringify(saved));
  act(() => root.unmount());
  root = createRoot(container);
  await act(async () => root.render(<Harness mode="members" />));
  expect(setup.draft?.partners[0].form.catId).toBe('partner-legacy-long-journey-codex');
  expect(setup.draft?.partners[0].form.accountRef).toBe('custom-account');
  expect(setup.draft?.partners[0].form.cliConfigArgs).toEqual(['--settings', '/custom.json']);
});

it('retries a committed but unacknowledged member using the same request and payload after rediscovery', async () => {
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  let lost = true;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path === '/api/cats' && init?.method === 'POST' && lost) {
      lost = false;
      const form = JSON.parse(String(init.body));
      catalog.cats = [{ ...form, id: form.catId } as CatData];
      throw new Error('Response lost');
    }
    return original(path, init);
  });
  await act(async () => root.render(<Harness mode="members" />));
  await act(async () => setup.start());
  const first = vi.mocked(apiFetch).mock.calls.find(([path, init]) => path === '/api/cats' && init?.method === 'POST')!;
  await act(async () => setup.reload());
  await act(async () => setup.start());
  const retry = vi
    .mocked(apiFetch)
    .mock.calls.filter(([path, init]) => path === '/api/cats' && init?.method === 'POST')[1];
  expect(retry[1]?.body).toBe(first[1]?.body);
  expect(retry[1]?.headers).toEqual(first[1]?.headers);
});

it.each(['goal', 'members'] as const)('supports HTTP LAN and preserves the %s journey after remount', async (mode) => {
  const nativeCrypto = globalThis.crypto;
  vi.stubGlobal('crypto', { getRandomValues: nativeCrypto.getRandomValues.bind(nativeCrypto) });
  try {
    await act(async () => root.render(<Harness mode={mode} />));
    expect(setup.error).toBe('');
    const journey = setup.draft?.journeyId;
    expect(journey).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
    expect(setup.draft?.partners.filter((p) => p.selected)).toHaveLength(3);
    act(() => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<Harness mode={mode} />));
    expect(setup.draft?.journeyId).toBe(journey);
    await act(async () => setup.start());
    const creates = vi
      .mocked(apiFetch)
      .mock.calls.filter(([path, init]) => path === '/api/cats' && init?.method === 'POST');
    expect(creates).toHaveLength(3);
    expect(creates[0][1]?.headers).toMatchObject({ 'X-Cat-Cafe-Onboarding-Journey': journey });
  } finally {
    vi.stubGlobal('crypto', nativeCrypto);
  }
});

it('resumes a partially created team without duplicating members or sending a task', async () => {
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  let creations = 0;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path === '/api/cats' && init?.method === 'POST' && ++creations === 2)
      return response({ error: '创建中断' }, 503);
    return original(path, init);
  });
  await act(async () => root.render(<Harness mode="members" />));
  await act(async () => setup.start());
  expect(setup.errorStage).toBe('save');
  expect(Object.keys(setup.draft?.created ?? {})).toHaveLength(1);
  await act(async () => setup.start());
  expect(creations).toBe(4);
  expect(vi.mocked(apiFetch).mock.calls.some(([path]) => path === '/api/threads')).toBe(false);
  expect(onCreated).toHaveBeenCalledOnce();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

it('does not write before confirmation; creates all native partners then prefills a real conversation', async () => {
  await act(async () => root.render(<Harness />));
  expect(setup.draft?.partners.filter((p) => p.selected)).toHaveLength(3);
  expect(vi.mocked(apiFetch).mock.calls.every(([, init]) => !init?.method)).toBe(true);
  await act(async () => setup.start());
  const writes = vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(writes.map(([path]) => path)).toEqual(['/api/cats', '/api/cats', '/api/cats', '/api/threads']);
  for (const [, init] of writes.slice(0, 3))
    expect(JSON.parse(String(init?.body))).toMatchObject({ configurationSource: 'native_tool', defaultModel: '' });
  expect(JSON.parse(String(writes[3][1]?.body))).not.toHaveProperty('bootcampState');
  expect(onCreated).toHaveBeenCalledWith('ordinary-goal', expect.any(String));
  expect(getThreadDraft('ordinary-goal')).toContain('@codex');
  expect(getThreadDraft('ordinary-goal')).toContain('@claude-code');
  expect(getThreadDraft('ordinary-goal')).toContain('@dsh');
  expect(getThreadDraft('ordinary-goal')).toContain('#execute');
  expect(getThreadDraft('ordinary-goal')).toContain('检查前面伙伴的方案');
  expect(getThreadDraft('ordinary-goal')).toContain('3 个步骤');
});

it('puts the chosen lead first and dispatches every selected partner, but no deselected partner', async () => {
  await act(async () => root.render(<Harness />));
  await act(async () => {
    setup.patchPartner(setup.draft!.partners[2].id, { selected: false });
    setup.patch({ lead: 'claude', goal: '整理笔记' });
  });
  await act(async () => setup.start());
  const message = getThreadDraft('ordinary-goal');
  expect(message).toMatch(/^@claude-code @codex\n/);
  expect(message).not.toContain('@dsh');
  expect(message).toContain('汇总');
});

it('keeps a single-partner goal simple', async () => {
  await act(async () => root.render(<Harness />));
  await act(async () => {
    for (const partner of setup.draft!.partners.slice(1)) setup.patchPartner(partner.id, { selected: false });
    setup.patch({ goal: '整理笔记' });
  });
  await act(async () => setup.start());
  expect(getThreadDraft('ordinary-goal')).toBe('@codex 整理笔记');
});

it('preserves deselection of an existing partner across detection refreshes', async () => {
  catalog.cats = [
    {
      id: 'existing-codex',
      carrier: 'app_server',
      displayName: '现有伙伴',
      clientId: 'openai',
      configurationSource: 'native_tool',
      defaultModel: '',
      color: { primary: '#000000', secondary: '#ffffff' },
      mentionPatterns: ['@existing'],
      avatar: '',
      roleDescription: '',
      personality: '',
    },
  ];
  await act(async () => root.render(<Harness />));
  expect(setup.draft?.partners[0].existingId).toBe('existing-codex');
  await act(async () => setup.patchPartner('codex', { selected: false }));
  await act(async () => setup.reload());
  expect(setup.draft?.partners[0].selected).toBe(false);
  await act(async () => setup.start());
  expect(getThreadDraft('ordinary-goal')).not.toContain('@existing');
});

it('blocks starting from stale detection data after a failed refresh', async () => {
  await act(async () => root.render(<Harness />));
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) =>
    String(path).split('?')[0] === '/api/cats/native-runtimes'
      ? response({ error: '检测服务不可用' }, 503)
      : original(path, init),
  );
  await act(async () => setup.reload());
  await act(async () => setup.start());
  expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});

it('retains successful members when thread creation fails and resumes without duplicate writes', async () => {
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  let failThread = true;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path === '/api/threads' && failThread) {
      failThread = false;
      return response({ error: '暂时不可用' }, 503);
    }
    return original(path, init);
  });
  await act(async () => root.render(<Harness />));
  await act(async () => setup.start());
  expect(setup.error).toBe('暂时不可用');
  expect(onCreated).not.toHaveBeenCalled();
  expect(Object.keys(setup.draft?.created ?? {})).toHaveLength(3);
  await act(async () => setup.reload());
  await act(async () => setup.start());
  expect(
    vi.mocked(apiFetch).mock.calls.filter(([path, init]) => path === '/api/cats' && init?.method === 'POST'),
  ).toHaveLength(3);
  expect(onCreated).toHaveBeenCalledOnce();
});

it('recommends a newly installed tool on refresh but preserves an explicit deselection', async () => {
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  let installed = false;
  vi.mocked(apiFetch).mockImplementation(async (path, init) =>
    String(path).split('?')[0] === '/api/cats/native-runtimes'
      ? response({ runtimes: runtimes.map((runtime) => ({ ...runtime, installed })) })
      : original(path, init),
  );
  await act(async () => root.render(<Harness />));
  expect(setup.draft?.partners.some((p) => p.selected)).toBe(false);
  installed = true;
  await act(async () => setup.reload());
  expect(vi.mocked(apiFetch).mock.calls.some(([path]) => path === '/api/cats/native-runtimes?refresh=1')).toBe(true);
  expect(setup.draft?.partners.every((p) => p.selected)).toBe(true);
  await act(async () => setup.patchPartner('codex', { selected: false }));
  await act(async () => setup.reload());
  expect(setup.draft?.partners.find((p) => p.id === 'codex')?.selected).toBe(false);
});

it('refresh restores each CodeAgent identity draft separately even when all three share the same launch descriptor', async () => {
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  const names = ['宪宪', '砚砚', '墨墨'];
  const templates = ['ragdoll', 'maine-coon', 'turkish-van'].map((id, i) => ({
    id,
    name: names[i],
    nickname: names[i],
    avatar: '/avatars/default.png',
    color: { primary: '#111111', secondary: '#eeeeee' },
    roleDescription: 'role',
    personality: 'personality',
  }));
  const discovered = templates.map((template) => ({
    id: `codeagent:${template.id}`,
    label: `CodeAgent · ${template.nickname}`,
    clientId: 'acp',
    installed: true,
    models: [],
    priority: 100,
    roleTemplateId: template.id,
    acp: { command: 'codeagent', startupArgs: ['--acp'] },
  }));
  vi.mocked(apiFetch).mockImplementation((path, init) =>
    String(path).startsWith('/api/cats/native-runtimes')
      ? Promise.resolve(response({ runtimes: discovered }))
      : path === '/api/cat-templates'
        ? Promise.resolve(response({ templates }))
        : original(path, init),
  );
  await act(async () => root.render(<Harness mode="members" />));
  expect(setup.draft?.partners.map((partner) => partner.form.nickname)).toEqual(names);
  const first = setup.draft!.partners[0];
  await act(async () => setup.patchPartner(first.id, { form: { ...first.form, nickname: '我的宪宪' } }));
  await act(async () => setup.reload());
  expect(setup.draft?.partners.map((partner) => partner.form.nickname)).toEqual(['我的宪宪', '砚砚', '墨墨']);
});
