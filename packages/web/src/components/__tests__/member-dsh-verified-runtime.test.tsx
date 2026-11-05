import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { useMemberModelCatalogs } from '@/lib/member-model-display';
import { apiFetch } from '@/utils/api-client';
import { serializeCommandArgs } from '../hub-cat-editor.acp';
import { initialState } from '../hub-cat-editor.model';
import { MemberRuntimeSummary } from '../members/MemberRuntimeSummary';
import { MemberRuntimeFields } from '../settings/members/MemberRuntimeFields';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

it.each([
  {
    name: 'ordinary official install',
    entry: '/install/node_modules/@deepseek-ai/dsh/lib/bin.js',
    verified: true,
    dsh: true,
  },
  { name: 'verified package outside node_modules', entry: '/some/install/dsh/lib/bin.js', verified: true, dsh: true },
  {
    name: 'verified package with fresh ACP profile',
    entry: '/some/install/dsh/lib/bin.js',
    verified: true,
    profileState: 'acp_profile_missing' as const,
    dsh: true,
  },
  { name: 'friendly label without verification', entry: '/some/install/dsh/lib/bin.js', verified: false, dsh: false },
  {
    name: 'effective plugin with retained verified startup',
    entry: '/some/install/dsh/lib/bin.js',
    verified: true,
    plugin: 'plugin:official.codeagent/codeagent',
    dsh: false,
  },
  {
    name: 'different profile arguments',
    entry: '/some/install/dsh/lib/bin.js',
    verified: true,
    profile: 'other',
    dsh: false,
  },
  {
    name: 'different node command',
    entry: '/some/install/dsh/lib/bin.js',
    verified: true,
    command: 'custom-acp',
    dsh: false,
  },
  {
    name: 'different transport',
    entry: '/some/install/dsh/lib/bin.js',
    verified: true,
    transport: 'httpstream' as const,
    dsh: false,
  },
])('uses backend verification for the exact startup: $name', async ({
  entry,
  verified,
  plugin,
  profile,
  command,
  transport,
  profileState,
  dsh,
}) => {
  const route = '["deepseek-official","deepseek-flash"]';
  const acp = {
    command: command || 'node',
    startupArgs: [entry, '--profile', profile || 'acp'],
    transport: transport || ('stdio' as const),
  };
  const cat = {
    id: 'verified-dsh',
    clientId: 'acp',
    carrier: 'acp',
    configurationSource: 'native_tool',
    defaultModel: '',
    agentProvider: plugin,
    acp,
  } as CatData;
  const runtime = {
    id: 'acp:verified-dsh',
    label: 'DSH',
    clientId: 'acp',
    installed: true,
    models: [],
    ...(verified ? { discoveryStatus: profileState || 'configured' } : {}),
    acp: { command: 'node', startupArgs: [entry, '--profile', 'acp'], transport: 'stdio' },
  };
  vi.mocked(apiFetch).mockImplementation(
    async (url) =>
      new Response(
        JSON.stringify(
          url.startsWith('/api/cats/native-runtimes')
            ? { runtimes: [runtime] }
            : url === '/api/agent-providers'
              ? { libraries: [] }
              : {
                  status: 'live',
                  defaultModel: route,
                  defaultModelStatus: 'reported',
                  models: [{ value: route, label: 'DeepSeek Flash' }],
                },
        ),
      ),
  );
  const host = document.createElement('div');
  const root = createRoot(host);
  const patch = vi.fn();
  try {
    await act(async () =>
      root.render(
        <>
          <MemberRuntimeFields
            form={{
              ...initialState(),
              catId: cat.id,
              clientId: 'acp',
              carrier: 'acp',
              configurationSource: 'native_tool',
              acpAgentProvider: plugin,
              acpCommand: acp.command,
              acpStartupArgs: serializeCommandArgs(acp.startupArgs),
              acpTransport: acp.transport,
              defaultModel: '',
            }}
            accounts={[]}
            patch={patch}
            t={(zh) => zh}
            accountHref="/settings?s=accounts"
            editing
          />
          <div data-testid="shared">
            <MemberRuntimeSummary cat={cat} />
          </div>
        </>,
      ),
    );
    const trigger = host.querySelector<HTMLButtonElement>('[role=combobox]');
    expect(trigger?.textContent?.includes('DeepSeek Flash')).toBe(dsh);
    expect(host.textContent?.includes('DSH 自定义 LLM')).toBe(dsh);
    expect(host.querySelector('[data-testid=shared]')?.textContent?.includes('DSH · DeepSeek Flash')).toBe(dsh);
    expect(patch).not.toHaveBeenCalled();
    const refresh = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === '刷新',
    );
    await act(async () => refresh?.click());
    expect(patch).not.toHaveBeenCalled();
    if (dsh) {
      expect(trigger?.textContent).toContain('DeepSeek Flash · 跟随 DSH 设置');
      await act(async () => trigger?.click());
      const options = [...host.querySelectorAll<HTMLButtonElement>('[role=option]')];
      expect(options.filter((option) => option.getAttribute('aria-selected') === 'true')).toHaveLength(1);
      expect(options[0].getAttribute('aria-selected')).toBe('true');
      expect(options[1].textContent).toContain('当前继承模型');
      await act(async () => options[1].click());
      expect(patch).toHaveBeenLastCalledWith({ defaultModel: route });
      await act(async () => trigger?.click());
      await act(async () => host.querySelector<HTMLButtonElement>('[role=option]')?.click());
      expect(patch).toHaveBeenLastCalledWith({ defaultModel: '' });
    }
  } finally {
    await act(async () => root.unmount());
    useMemberModelCatalogs.setState(useMemberModelCatalogs.getInitialState(), true);
    vi.resetAllMocks();
  }
});
