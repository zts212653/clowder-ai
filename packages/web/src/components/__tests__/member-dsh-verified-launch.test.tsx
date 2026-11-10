import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { useMemberModelCatalogs } from '@/lib/member-model-display';
import { apiFetch } from '@/utils/api-client';
import { NativePartnerCard } from '../first-run-quest/NativePartnerCard';
import type { NativePartner } from '../first-run-quest/native-onboarding';
import { initialState } from '../hub-cat-editor.model';
import { MemberRuntimeSummary } from '../members/MemberRuntimeSummary';
import { MemberRuntimeFields } from '../settings/members/MemberRuntimeFields';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(() => {
  vi.resetAllMocks();
  useMemberModelCatalogs.setState({ catalogs: {}, runtimes: [] });
});

it.each([
  ['verified official package outside node_modules', 'verified', true],
  ['friendly label alone', 'label-only', false],
  ['different startup arguments', 'changed-args', false],
  ['effective plugin binding', 'plugin', false],
  ['Pi discovery with a configured status', 'pi', false],
] as const)('keeps display and setup tied to %s', async (_name, mode, expectedDsh) => {
  const entry = '/fixture/installed/dsh/lib/bin.js';
  const acp = { command: 'node', startupArgs: [entry, '--profile', 'acp'] };
  const route = '["deepseek-official","deepseek-flash"]';
  const agentProvider = mode === 'plugin' ? 'plugin:official.codeagent/codeagent' : undefined;
  const cat = {
    id: 'dsh-verified-path',
    clientId: 'acp',
    configurationSource: 'native_tool',
    defaultModel: '',
    agentProvider,
    acp,
  } as CatData;
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    if (url === '/api/cats/native-runtimes')
      return new Response(
        JSON.stringify({
          runtimes: [
            {
              id: mode === 'pi' ? 'pi' : `acp:${cat.id}`,
              label: 'DSH',
              clientId: 'acp',
              installed: true,
              // Native discovery emits this only after inspecting this registered DSH profile.
              ...(mode === 'label-only' ? {} : { discoveryStatus: 'configured' }),
              acp: mode === 'changed-args' ? { ...acp, startupArgs: [...acp.startupArgs, '--custom'] } : acp,
              models: [],
            },
          ],
        }),
      );
    if (url === '/api/agent-providers') return new Response(JSON.stringify({ libraries: [] }));
    return new Response(
      JSON.stringify({
        status: 'live',
        defaultModel: route,
        defaultModelLabel: 'DeepSeek Flash',
        defaultModelSource: 'client_report',
        models: [{ value: route, label: 'DeepSeek Flash' }],
      }),
    );
  });
  const patch = vi.fn();
  const host = document.createElement('div');
  const root = createRoot(host);
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
              defaultModel: '',
              acpAgentProvider: agentProvider,
              acpCommand: acp.command,
              acpStartupArgs: acp.startupArgs.join(' '),
            }}
            accounts={[]}
            patch={patch}
            t={(zh) => zh}
            accountHref="/settings?s=accounts"
            editing
          />
          <div data-testid="shared-summary">
            <MemberRuntimeSummary cat={cat} />
          </div>
        </>,
      ),
    );
    const trigger = host.querySelector<HTMLButtonElement>('[role=combobox]');
    expect(patch).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain('复用 DSH Desktop');
    expect(host.querySelector<HTMLSelectElement>('select[aria-label="使用工具"]')?.value === 'dsh').toBe(expectedDsh);
    const summary = host.querySelector('[data-testid=shared-summary]')?.textContent;
    if (!expectedDsh) {
      expect(summary).not.toContain('DeepSeek Flash');
      return;
    }
    expect(trigger?.textContent).toContain('DeepSeek Flash · 跟随 DSH 设置');
    expect(summary).toContain('DSH · DeepSeek Flash · 跟随工具设置');
    await act(async () => trigger?.click());
    const selected = host.querySelector<HTMLButtonElement>('[role=option][aria-selected=true]');
    expect(selected?.textContent).toContain('跟随 DSH 设置');
    await act(async () => selected?.click());
    expect(patch).toHaveBeenLastCalledWith({ defaultModel: '' });
    await act(async () => trigger?.click());
    const model = [...host.querySelectorAll<HTMLButtonElement>('[role=option]')].find(
      (option) => option.getAttribute('aria-selected') !== 'true' && option.textContent?.includes('DeepSeek Flash'),
    );
    await act(async () => model?.click());
    expect(patch).toHaveBeenLastCalledWith({ defaultModel: route });
    expect(vi.mocked(apiFetch).mock.calls.some(([, request]) => request?.method === 'PATCH')).toBe(false);
  } finally {
    await act(async () => root.unmount());
  }
});

it.each([
  '/fixture/desktop-a/dsh.cmd',
  '/fixture/desktop-b/dsh.cmd',
])('keeps a visited Desktop panel and its selection while collapsed for %s', async (command) => {
  const args = ['--profile', 'acp'];
  const runtime = {
    id: 'dsh',
    label: 'DSH',
    clientId: 'acp' as const,
    installed: true,
    dshDesktop: true,
    models: [],
    acp: { command, startupArgs: args, transport: 'stdio' as const },
  };
  vi.mocked(apiFetch).mockImplementation(async (path) =>
    Response.json(
      path === '/api/cats/native-runtimes'
        ? { runtimes: [runtime] }
        : path.endsWith('/inspect')
          ? {
              revision: 'a'.repeat(64),
              provider: 'custom',
              model: 'custom-model',
              providers: [
                {
                  id: 'custom',
                  credential: 'configured',
                  models: [
                    { id: 'custom-model', label: 'Custom' },
                    { id: 'other-model', label: 'Other' },
                  ],
                },
              ],
            }
          : { status: 'live', models: [], effortOptions: [] },
    ),
  );
  const valid = () => {};
  function Card() {
    const [partner, setPartner] = useState<NativePartner>({
      id: 'native-panel',
      runtime,
      selected: true,
      form: {
        ...initialState(),
        catId: 'native-panel',
        name: 'Native panel',
        clientId: 'acp',
        carrier: 'acp',
        configurationSource: 'native_tool',
        acpCommand: command,
        acpStartupArgs: args.join(' '),
      },
    });
    return (
      <NativePartnerCard
        partner={partner}
        created={false}
        patch={(change) => setPartner((old) => ({ ...old, ...change }))}
        onValidityChange={valid}
      />
    );
  }
  const host = document.createElement('div');
  const root = createRoot(host);
  const click = async (text: string) => {
    const button = [...host.querySelectorAll('button')].find((item) => item.textContent === text);
    expect(button).toBeDefined();
    await act(async () => button?.click());
  };
  try {
    await act(async () => root.render(<Card />));
    expect(apiFetch).not.toHaveBeenCalled();
    await click('调整');
    const chooser = host.querySelector<HTMLSelectElement>('select[aria-label="DSH 模型"]')!;
    await act(async () => {
      chooser.value = '["custom","other-model"]';
      chooser.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const reads = vi.mocked(apiFetch).mock.calls.length;
    await click('收起');
    await click('调整');
    expect(host.querySelector<HTMLSelectElement>('select[aria-label="DSH 模型"]')?.value).toBe(
      '["custom","other-model"]',
    );
    expect(vi.mocked(apiFetch).mock.calls).toHaveLength(reads);
    expect(vi.mocked(apiFetch).mock.calls.some(([path]) => path.endsWith('/prepare') || path.endsWith('/test'))).toBe(
      false,
    );
    expect(vi.mocked(apiFetch).mock.calls.some(([, request]) => request?.method === 'PATCH')).toBe(false);
  } finally {
    await act(async () => root.unmount());
  }
});
