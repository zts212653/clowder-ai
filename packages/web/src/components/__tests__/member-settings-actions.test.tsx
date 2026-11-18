import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { apiFetch } from '@/utils/api-client';
import type { ConfigData } from '../config-viewer-types';
import { MemberSettingsHost } from '../settings/members/MemberSettingsHost';
import { MemberSettingsPage } from '../settings/members/MemberSettingsPage';
import { SettingsContent } from '../settings/SettingsContent';
import { writeShellLanguage } from '../shell/shell-language';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push }),
  useSearchParams: () => new URLSearchParams('lang=zh'),
}));
const { push, confirm, refresh } = vi.hoisted(() => ({ push: vi.fn(), confirm: vi.fn(), refresh: vi.fn() }));
vi.mock('../shell/shell-presentation', () => ({ useShellPresentation: () => 'v2' }));
vi.mock('../useConfirm', () => ({ useConfirm: () => confirm }));
vi.mock('@/hooks/useCatData', async (original) => ({
  ...(await original<typeof import('@/hooks/useCatData')>()),
  useCatData: () => ({ cats: [cat], refresh, hasFetched: true, isLoading: false }),
}));
vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn(), API_URL: 'isolated-actions-test' }));
vi.mock('../members/MemberListHost', () => ({ MemberListHost: () => <div>成员列表</div> }));
vi.mock('../settings/members/MemberRuntimeFields', () => ({ MemberRuntimeFields: () => <div>模型与工具</div> }));
const cat = {
  id: 'fixture-cat',
  name: 'fixture',
  displayName: '测试伙伴',
  clientId: 'anthropic',
  configurationSource: 'native_tool',
  defaultModel: '',
  mentionPatterns: ['@fixture'],
  color: { primary: '#123456', secondary: '#abcdef' },
  configurationRevision: '1'.repeat(64),
} as CatData;
let host: HTMLDivElement, root: Root;
const close = vi.fn(),
  remove = vi.fn<(cat: CatData) => Promise<boolean>>();
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  sessionStorage.clear();
  vi.clearAllMocks();
  vi.mocked(apiFetch).mockImplementation(
    async (path) =>
      new Response(
        JSON.stringify(
          path === '/api/accounts'
            ? { providers: [], projectPath: '/fixture' }
            : path === '/api/session'
              ? { userId: 'test' }
              : path === '/api/cat-templates'
                ? { templates: [] }
                : { cats: [] },
        ),
      ),
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
async function render(editorOpen: boolean, error: string | null = null, members: CatData[] = [cat]) {
  await act(async () =>
    root.render(
      <MemberSettingsHost
        v2
        editorOpen={editorOpen}
        editingCat={editorOpen ? cat : null}
        cats={members}
        config={{ cats: {} } as ConfigData}
        configError={error}
        registryLoading={false}
        registryKnown
        creationView={null}
        onRetryConfig={vi.fn()}
        onRetryRegistry={vi.fn()}
        onOpen={vi.fn()}
        onClose={close}
        onSaved={vi.fn()}
        onTeamCreated={vi.fn()}
        onEditCoCreator={vi.fn()}
        onDelete={remove}
        onToggle={vi.fn()}
        togglingCatId={null}
      />,
    ),
  );
}

it('shows the current estimate and refreshes it when the roster changes', async () => {
  let number = 6100;
  const previous = vi.mocked(apiFetch).getMockImplementation();
  if (!previous) throw new Error('API mock is unavailable');
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path === '/api/cats/l0-budget')
      return new Response(
        JSON.stringify({ referenceTokens: 6000, members: [{ catId: 'fixture-cat', tokens: number }] }),
      );
    return previous(path, init);
  });
  await render(false);
  expect(host.textContent).toContain('6100 tokens');
  expect(host.textContent).toContain('不是模型上限');
  number = 6250;
  await render(false, null, [cat, { ...cat, id: 'new-fixture' }]);
  expect(host.textContent).toContain('6250 tokens');
  await render(true);
  expect(host.querySelector('[data-testid=member-save-bar]')?.textContent).toContain('6250 tokens');
});

it('translates an existing estimate without recalculating it', async () => {
  let audits = 0;
  const previous = vi.mocked(apiFetch).getMockImplementation();
  if (!previous) throw new Error('API mock is unavailable');
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path === '/api/cats/l0-budget') {
      audits++;
      return new Response(JSON.stringify({ referenceTokens: 6000, members: [{ catId: 'fixture-cat', tokens: 6100 }] }));
    }
    return previous(path, init);
  });
  try {
    await render(false);
    expect(audits).toBe(1);
    await act(async () => writeShellLanguage('en'));
    expect(host.textContent).toContain('Estimated L0 fixed prompt');
    expect(host.textContent).toContain('6100 tokens');
    expect(audits).toBe(1);
  } finally {
    await act(async () => writeShellLanguage('zh'));
  }
});

it('keeps the settings tool identity ACP when only its provider argument mentions DeepSeek', async () => {
  const custom = {
    ...cat,
    carrier: 'acp',
    clientId: 'acp',
    acp: { command: 'custom-acp', startupArgs: ['--provider', 'deepseek'] },
  } as CatData;
  await act(async () =>
    root.render(<MemberSettingsPage cat={custom} cats={[custom]} onSaved={vi.fn()} onBack={vi.fn()} />),
  );
  expect(host.querySelector('[data-testid=member-settings-page]')?.textContent).not.toContain('DSH');
});
it.each([false, true])('keeps action failures visible with an existing config (detail=%s)', async (detail) => {
  await render(detail, '成员状态切换失败 (503)');
  expect(host.querySelector('[role=alert]')?.textContent).toContain('成员状态切换失败 (503)');
});
it.each([false, true])('only returns to the list after confirmed successful deletion (success=%s)', async (success) => {
  remove.mockResolvedValue(success);
  await render(true);
  const button = [...host.querySelectorAll('button')].find((item) => item.textContent?.includes('删除成员'));
  expect(button).toBeDefined();
  await act(async () => button?.click());
  expect(remove).toHaveBeenCalledExactlyOnceWith(cat);
  expect(close).toHaveBeenCalledTimes(success ? 1 : 0);
});

it.each([
  'cancel',
  'http-failure',
  'network-failure',
  'success',
])('preserves the real delete confirmation and request outcome (%s)', async (outcome) => {
  confirm.mockResolvedValue(outcome !== 'cancel');
  const previous = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (init?.method === 'DELETE') {
      if (outcome === 'network-failure') throw new Error('fixture network failure');
      return new Response(JSON.stringify(outcome === 'http-failure' ? { error: '删除失败 (503)' } : {}), {
        status: outcome === 'http-failure' ? 503 : 200,
      });
    }
    if (path === '/api/config') return new Response(JSON.stringify({ config: { cats: {} } }));
    return previous(path, init);
  });
  await act(async () => root.render(<SettingsContent section="members" initialEditCatId={cat.id} />));
  const button = [...host.querySelectorAll('button')].find((item) => item.textContent?.includes('删除成员'));
  expect(button).toBeDefined();
  await act(async () => button?.click());
  expect(confirm).toHaveBeenCalledOnce();
  expect(vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(
    outcome === 'cancel' ? 0 : 1,
  );
  expect(push).toHaveBeenCalledTimes(outcome === 'success' ? 1 : 0);
  const deletion = vi.mocked(apiFetch).mock.calls.find(([, init]) => init?.method === 'DELETE');
  if (deletion) expect(JSON.parse(String(deletion[1]?.body)).expectedRevision).toBe(cat.configurationRevision);
  if (outcome.endsWith('failure')) expect(host.querySelector('[role=alert]')?.textContent).toContain('删除失败');
});
