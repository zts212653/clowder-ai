import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { apiFetch } from '@/utils/api-client';
import { FirstRunQuestWizard } from '../../FirstRunQuestWizard';
import { RecommendedTeamSetup } from '../../settings/members/RecommendedTeamSetup';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
const refresh = vi.fn();
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ refresh }) }));
const args = ['--profile', 'acp', '--patch', '/host/.cat-cafe/dsh-acp/4240a628-b64d-404d-ae4e-d98b6ad42aff.yml'];
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
let persisted: CatData, host: HTMLDivElement, root: Root;
let failPatch = 0,
  losePatchResponse = false,
  customBinding = false;
const onCreated = vi.fn();

function runtimes() {
  const required = !persisted.acp?.startupArgs.includes(args[args.length - 1]);
  const base = {
    harnessId: 'dsh',
    label: 'DSH',
    clientId: 'acp',
    installed: true,
    models: [],
    dshSetup: {
      status: 'configured',
      sourceProfile: 'desktop',
      revision: 'source-revision',
      provider: 'company',
      model: 'private-model',
    },
  };
  return [
    {
      ...base,
      id: 'dsh',
      kind: 'tool',
      dshSetupRequired: true,
      acp: { command: 'dsh', startupArgs: ['--profile', 'acp'], transport: 'stdio' },
    },
    {
      ...base,
      id: `acp:${persisted.id}`,
      kind: 'binding',
      sourceCatId: persisted.id,
      dshSetup: { ...base.dshSetup, revision: customBinding ? 'binding-revision' : 'source-revision' },
      dshSetupRequired: required,
      acp: persisted.acp,
    },
  ];
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  failPatch = 0;
  losePatchResponse = false;
  customBinding = false;
  onCreated.mockReset();
  refresh.mockReset();
  persisted = {
    id: 'existing-whale',
    name: '小鲸鱼',
    displayName: '小鲸鱼',
    nickname: '鲸鲸',
    clientId: 'acp',
    carrier: 'acp',
    configurationSource: 'native_tool',
    defaultModel: 'old-official-model',
    cli: { effort: 'high' },
    configurationRevision: 'a'.repeat(64),
    mentionPatterns: ['@鲸鲸'],
    color: { primary: '#111111', secondary: '#eeeeee' },
    acp: {
      command: 'dsh',
      startupArgs: ['--profile', 'acp'],
      transport: 'stdio',
      mcpWhitelist: ['clowder'],
      pool: { idleTtlMs: 123456, maxLiveProcesses: 2 },
    },
  } as CatData;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (String(path).startsWith('/api/cats/native-runtimes'))
      return response({ edition: 'intranet', runtimes: runtimes() });
    if (path === '/api/session') return response({ userId: 'existing-dsh-repair' });
    if (path === '/api/cat-templates') return response({ templates: [] });
    if (path === '/api/cats') return response({ cats: [persisted] });
    if (path === '/api/threads') return response({ id: 'repaired-existing-thread' });
    if (path === '/api/agent-providers') return response({ libraries: [] });
    if (path === '/api/cats/runtime-models') return response({ status: 'live', models: [] });
    if (path === '/api/cats/dsh-setup/inspect')
      return response({
        profiles: ['acp', 'desktop'],
        sourceProfile: 'desktop',
        revision: 'source-revision',
        active: { provider: 'deepseek-official', model: 'old-official-model', providers: [] },
        source: {
          providers: [
            { id: 'company', credentialStatus: 'configured', models: [{ id: 'private-model', label: 'Private' }] },
          ],
        },
      });
    if (path === '/api/cats/dsh-setup/prepare') {
      const selection = JSON.parse(String(init?.body));
      if (customBinding && (selection.runtimeId !== `acp:${persisted.id}` || selection.revision !== 'binding-revision'))
        return response({ error: 'dsh_setup_changed' }, 409);
      return response({
        id: 'prepared',
        command: persisted.acp?.command,
        startupArgs: customBinding ? [...(persisted.acp?.startupArgs ?? []), '--patch', args[args.length - 1]] : args,
      });
    }
    if (path === '/api/cats/existing-whale' && init?.method === 'PATCH') {
      const patch = JSON.parse(String(init.body));
      if (failPatch-- > 0) return response({ error: 'temporary_write_failure' }, 503);
      if (patch.expectedRevision !== persisted.configurationRevision)
        return response({ error: 'member_config_conflict' }, 409);
      const changes = { ...patch };
      delete changes.expectedRevision;
      persisted = {
        ...persisted,
        ...changes,
        cli: { ...persisted.cli, ...changes.cli },
        configurationRevision: 'b'.repeat(64),
      };
      if (losePatchResponse) {
        losePatchResponse = false;
        throw Error('response_lost');
      }
      return response({ cat: persisted });
    }
    throw Error(`Unexpected API: ${path} ${init?.method ?? 'GET'}`);
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  localStorage.clear();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});
async function mount() {
  await act(async () =>
    root.render(<RecommendedTeamSetup onCreated={onCreated} onBack={vi.fn()} onManual={vi.fn()} />),
  );
}
async function click(label: string | RegExp) {
  const button = [...document.body.querySelectorAll('button')].find((item) =>
    typeof label === 'string' ? item.textContent === label : label.test(item.textContent ?? ''),
  );
  if (!button || button.disabled) throw Error(`Unavailable button: ${label}`);
  await act(async () => button.click());
}
const writes = () =>
  vi
    .mocked(apiFetch)
    .mock.calls.filter(
      ([, init]) => ['POST', 'PATCH'].includes(init?.method ?? '') && !String(init?.body).includes('source-revision'),
    );

it('prepares the exact existing binding when its DSH entry and extra patch differ from the tool default', async () => {
  customBinding = true;
  const oldAcp = persisted.acp;
  if (!oldAcp) throw Error('Fixture ACP missing');
  const customArgs = ['C:/Tools/dsh/lib/bin.js', '--profile', 'acp', '--patch', 'C:/DSH/company-existing.yml'];
  persisted.acp = {
    ...oldAcp,
    command: 'C:/Tools/dsh/node.exe',
    startupArgs: customArgs,
  };
  const original = structuredClone(persisted);
  await mount();
  await click(/保存.*配置|查看我的团队|一键创建/);
  expect(onCreated).toHaveBeenCalledOnce();
  const prepared = vi.mocked(apiFetch).mock.calls.find(([path]) => path === '/api/cats/dsh-setup/prepare');
  expect(JSON.parse(String(prepared?.[1]?.body))).toEqual({
    runtimeId: `acp:${original.id}`,
    sourceProfile: 'desktop',
    revision: 'binding-revision',
    provider: 'company',
    model: 'private-model',
  });
  expect(persisted.acp?.command).toBe(original.acp?.command);
  expect(persisted.acp?.startupArgs).toEqual([...customArgs, '--patch', args[args.length - 1]]);
  expect(persisted.acp?.mcpWhitelist).toEqual(original.acp?.mcpWhitelist);
  expect(persisted.acp?.pool).toEqual(original.acp?.pool);
  for (const field of ['id', 'name', 'displayName', 'nickname', 'mentionPatterns', 'color'] as const)
    expect(persisted[field]).toEqual(original[field]);
  expect(writes().some(([path]) => path === '/api/cats')).toBe(false);
});

it('confirms the Desktop route and repairs the original member via revision-protected PATCH, then reopens without preparation', async () => {
  const original = structuredClone(persisted);
  await mount();
  expect(host.textContent).toContain('复用 desktop 配置');
  await click(/保存.*配置|查看我的团队|一键创建/);
  const patches = writes().filter(([path, init]) => path === '/api/cats/existing-whale' && init?.method === 'PATCH');
  expect(patches).toHaveLength(1);
  const patch = JSON.parse(String(patches[0][1]?.body));
  expect(Object.keys(patch).sort()).toEqual(['acp', 'cli', 'defaultModel', 'expectedRevision']);
  expect(patch.expectedRevision).toBe(original.configurationRevision);
  expect(persisted.acp?.startupArgs).toEqual(args);
  expect(persisted.acp?.mcpWhitelist).toEqual(original.acp?.mcpWhitelist);
  expect(persisted.acp?.pool).toEqual(original.acp?.pool);
  expect(persisted.defaultModel).toBe('');
  expect(persisted.cli?.effort).toBeFalsy();
  for (const field of ['id', 'name', 'displayName', 'nickname', 'mentionPatterns', 'color'] as const)
    expect(persisted[field]).toEqual(original[field]);
  expect(writes().some(([path]) => path === '/api/cats')).toBe(false);
  expect(onCreated).toHaveBeenCalledOnce();
  await act(async () => root.unmount());
  vi.mocked(apiFetch).mockClear();
  root = createRoot(host);
  await mount();
  expect(host.querySelector('fieldset')).toBeNull();
  expect(vi.mocked(apiFetch).mock.calls.some(([path]) => path.endsWith('/inspect') || path.endsWith('/prepare'))).toBe(
    false,
  );
});

it('keeps the original ID and prepared draft after a write failure and retries without creating a member', async () => {
  failPatch = 1;
  await mount();
  await click(/保存.*配置|查看我的团队|一键创建/);
  expect(host.textContent).toContain('temporary_write_failure');
  expect(persisted.acp?.startupArgs).toEqual(['--profile', 'acp']);
  await click('重新检测');
  await click(/继续创建|保存.*配置|查看我的团队/);
  expect(persisted.acp?.startupArgs).toEqual(args);
  expect(writes().some(([path]) => path === '/api/cats')).toBe(false);
});

it('does not overwrite a concurrent revision and keeps the pending repair visible', async () => {
  await mount();
  persisted = { ...persisted, configurationRevision: 'c'.repeat(64), nickname: 'Owner concurrent name' };
  await click(/保存.*配置|查看我的团队|一键创建/);
  expect(host.textContent).toMatch(/conflict|已.*变更|重新检测/);
  expect(persisted.nickname).toBe('Owner concurrent name');
  expect(persisted.acp?.startupArgs).toEqual(['--profile', 'acp']);
  expect(onCreated).not.toHaveBeenCalled();
  await click('重新检测');
  expect(host.textContent).toContain('复用 desktop 配置');
  expect(host.textContent).toContain('保存 1 位伙伴配置');
});

it('recovers a committed PATCH whose response was lost by reading back the original member', async () => {
  losePatchResponse = true;
  await mount();
  await click(/保存.*配置|查看我的团队|一键创建/);
  expect(host.textContent).toContain('response_lost');
  await click(/继续创建|保存.*配置|查看我的团队/);
  expect(
    writes().filter(([path, init]) => path === '/api/cats/existing-whale' && init?.method === 'PATCH'),
  ).toHaveLength(1);
  expect(persisted.id).toBe('existing-whale');
  expect(onCreated).toHaveBeenCalledOnce();
});

it('allows the existing member repair through the real goal wizard without creating another member', async () => {
  await act(async () => root.render(<FirstRunQuestWizard open onClose={vi.fn()} onCreated={onCreated} />));
  expect(document.body.textContent).toContain('复用 desktop 配置');
  await click(/下一步.*1.*伙伴/);
  await click('保存伙伴，前往对话');
  expect(persisted.acp?.startupArgs).toEqual(args);
  expect(
    writes().filter(([path, init]) => path === '/api/cats/existing-whale' && init?.method === 'PATCH'),
  ).toHaveLength(1);
  expect(writes().some(([path]) => path === '/api/cats')).toBe(false);
  expect(onCreated).toHaveBeenCalledWith('repaired-existing-thread', '小鲸鱼');
});
