import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { apiFetch } from '@/utils/api-client';
import type { ConfigData } from '../config-viewer-types';
import { MemberSettingsHost } from '../settings/members/MemberSettingsHost';
import { SettingsContent } from '../settings/SettingsContent';

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
async function render(editorOpen: boolean, error: string | null = null) {
  await act(async () =>
    root.render(
      <MemberSettingsHost
        v2
        editorOpen={editorOpen}
        editingCat={editorOpen ? cat : null}
        cats={[cat]}
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
  if (outcome.endsWith('failure')) expect(host.querySelector('[role=alert]')?.textContent).toContain('删除失败');
});
