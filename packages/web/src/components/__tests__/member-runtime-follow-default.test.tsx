import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { useMemberModelCatalogs } from '@/lib/member-model-display';
import { apiFetch } from '@/utils/api-client';
import { parseAcpCatalog } from '../../../../api/src/routes/runtime-model-catalog';
import { FirstRunQuestWizard } from '../FirstRunQuestWizard';
import { recommendNativePartners } from '../first-run-quest/native-onboarding';
import { useNativeOnboarding } from '../first-run-quest/useNativeOnboarding';
import { MemberSettingsPage } from '../settings/members/MemberSettingsPage';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams('lang=zh'),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn(), API_URL: 'isolated-issue1933' }));
vi.mock('../first-run-quest/useNativeOnboarding', () => ({ useNativeOnboarding: vi.fn() }));

const runtime = {
  id: 'acp:issue1933',
  label: 'Fixture ACP',
  clientId: 'acp' as const,
  installed: true,
  models: [],
  acp: { command: 'fixture-acp', startupArgs: [], transport: 'stdio' as const },
};
const existing = {
  id: 'issue1933-existing',
  name: 'fixture',
  displayName: '测试伙伴',
  avatar: '',
  roleDescription: '',
  personality: '',
  clientId: 'acp',
  carrier: 'acp',
  configurationSource: 'native_tool',
  defaultModel: 'saved-bad-model',
  acp: runtime.acp,
  mentionPatterns: ['@fixture'],
  color: { primary: '#123456', secondary: '#abcdef' },
  configurationRevision: '1'.repeat(64),
} satisfies CatData;
const cases = [
  { name: 'duplicate', options: [{ value: 'observed' }, { value: 'observed' }] },
  { name: 'unadvertised', options: [{ value: 'another' }] },
  { name: 'missing choices', options: undefined },
];
let host: HTMLDivElement, root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  sessionStorage.clear();
  vi.clearAllMocks();
  useMemberModelCatalogs.setState({ runtimes: [], catalogs: {} });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

function installCatalog(options: (typeof cases)[number]['options']) {
  const session = { configOptions: [{ id: 'model', category: 'model', currentValue: 'observed', options }] };
  const catalog = parseAcpCatalog(session, session);
  expect(catalog.defaultModelStatus).toBe('unavailable');
  expect(catalog.defaultModel).toBeUndefined();
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    const data =
      path === '/api/cats/runtime-models'
        ? catalog
        : path === '/api/cats/native-runtimes'
          ? { runtimes: [runtime] }
          : path === '/api/accounts'
            ? { providers: [], projectPath: '/fixture' }
            : path === '/api/session'
              ? { userId: 'fixture' }
              : path === '/api/cat-templates'
                ? { templates: [] }
                : path === `/api/cats/${existing.id}` && init?.method === 'PATCH'
                  ? { cat: { ...existing, defaultModel: '', configurationRevision: '2'.repeat(64) } }
                  : { libraries: [], cats: [] };
    return new Response(JSON.stringify(data));
  });
}

it.each(cases)('keeps first-run Next enabled after reading a $name default', async ({ options }) => {
  installCatalog(options);
  const setup = {
    draft: {
      version: 2,
      journeyId: 'issue1933',
      partners: recommendNativePartners([runtime], [], [], 'issue1933'),
      goal: '测试目标',
      lead: '',
      created: {},
    },
    loading: false,
    error: '',
    errorStage: null,
    busy: '',
    patch: vi.fn(),
    patchPartner: vi.fn(),
    start: vi.fn(),
    reload: vi.fn(),
  } as unknown as ReturnType<typeof useNativeOnboarding>;
  vi.mocked(useNativeOnboarding).mockReturnValue(setup);
  await act(async () => root.render(<FirstRunQuestWizard open onClose={vi.fn()} onCreated={vi.fn()} />));
  const next = () => document.querySelector<HTMLButtonElement>('button[aria-label^="下一步"]');
  expect(next()?.disabled).toBe(false);
  const adjust = [...document.querySelectorAll('button')].find((button) => button.textContent === '调整');
  expect(adjust).toBeDefined();
  await act(async () => adjust?.click());
  expect(next()?.disabled).toBe(false);
  expect(document.body.textContent).toContain('默认模型尚未确认');
  expect(setup.draft?.partners[0].form.defaultModel).toBe('');
  await act(async () => next()?.click());
  await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="保存伙伴，前往对话"]')?.click());
  expect(setup.start).toHaveBeenCalledOnce();
});

it.each(cases)('can clear and save an existing model with a $name default', async ({ options }) => {
  installCatalog(options);
  const saved = vi.fn(async () => {});
  await act(async () =>
    root.render(<MemberSettingsPage cat={existing} cats={[existing]} onSaved={saved} onBack={vi.fn()} />),
  );
  const picker = host.querySelector<HTMLButtonElement>('button[role="combobox"]');
  expect(picker?.textContent).toContain('saved-bad-model');
  await act(async () => picker?.click());
  const follow = host.querySelector<HTMLButtonElement>('[role="option"]');
  expect(follow?.textContent).toContain('跟随');
  await act(async () => follow?.click());
  const save = [...host.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '保存');
  expect(save).toBeDefined();
  expect(save?.disabled).toBe(false);
  expect(host.textContent).toContain('默认模型尚未确认');
  await act(async () => save?.click());
  const write = vi
    .mocked(apiFetch)
    .mock.calls.find(([path, init]) => path === `/api/cats/${existing.id}` && init?.method === 'PATCH');
  expect(JSON.parse(String(write?.[1]?.body))).toMatchObject({
    defaultModel: '',
    expectedRevision: existing.configurationRevision,
  });
  expect(saved).toHaveBeenCalledOnce();
});
