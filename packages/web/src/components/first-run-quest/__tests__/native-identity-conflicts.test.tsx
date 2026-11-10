import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { apiFetch } from '@/utils/api-client';
import { NativePartnerCard } from '../NativePartnerCard';
import { useNativeOnboarding } from '../useNativeOnboarding';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ refresh: vi.fn() }) }));
vi.mock('../../settings/members/MemberRuntimeFields', () => ({ MemberRuntimeFields: () => null }));

const acp = { command: 'codeagent', startupArgs: ['--acp'], transport: 'stdio' };
const existing = {
  id: 'manual-ragdoll',
  displayName: '布偶猫',
  nickname: '宪宪',
  carrier: 'acp',
  clientId: 'acp',
  configurationSource: 'native_tool',
  defaultModel: 'user-model',
  acp: { ...acp, transport: 'stdio' as const },
  avatar: '/custom-ragdoll.png',
  color: { primary: '#123456', secondary: '#abcdef' },
  roleDescription: '用户设定的职责',
  personality: '用户设定的性格',
  mentionPatterns: ['@manual-ragdoll'],
} satisfies CatData;
const runtimes = [
  { id: 'codeagent', label: 'CodeAgent', clientId: 'acp', installed: true, models: [], acp },
  { id: 'claude', label: 'Claude Code', clientId: 'anthropic', installed: true, models: [] },
];
const templates = [{ ...existing, id: 'ragdoll', name: '布偶猫' }];
const response = (data: unknown) => new Response(JSON.stringify(data));
let root: Root;
let container: HTMLDivElement;
let setup: ReturnType<typeof useNativeOnboarding>;
const onCreated = vi.fn();

function Harness() {
  setup = useNativeOnboarding(true, onCreated, 'members');
  return (
    <>
      <p>{setup.error}</p>
      {setup.draft?.partners.map((partner) => (
        <NativePartnerCard
          key={partner.id}
          partner={partner}
          created={Boolean(partner.existingId || setup.draft?.created[partner.id])}
          patch={(change) => setup.patchPartner(partner.id, change)}
          onValidityChange={() => {}}
        />
      ))}
    </>
  );
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path === '/api/session') return response({ userId: 'identity-owner' });
    if (String(path).startsWith('/api/cats/native-runtimes')) return response({ runtimes });
    if (path === '/api/cat-templates') return response({ templates });
    if (path === '/api/config/onboarding/entry') return response({ status: 'pending' });
    if (path === '/api/cats') {
      if (!init?.method) return response({ cats: [existing] });
      return response({ cat: { id: 'new-claude', displayName: '布偶猫', mentionPatterns: ['@claude-code'] } });
    }
    throw new Error(`Unexpected request: ${path}`);
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

it('deselects conflicts restored from a saved draft and rejects explicit reselection before any write', async () => {
  await act(async () => root.render(<Harness />));
  await act(async () => {
    setup.patch({ initialRosterEmpty: true });
    setup.patchPartner('claude', { selected: true });
  });
  await act(async () => setup.reload());
  expect(setup.draft?.partners.find((partner) => partner.id === 'claude')?.selected).toBe(false);
  await act(async () => setup.patchPartner('claude', { selected: true }));
  vi.mocked(apiFetch).mockClear();
  await act(async () => setup.start());
  expect(setup.error).toContain('同名');
  expect(vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method)).toHaveLength(0);
  expect(onCreated).not.toHaveBeenCalled();
});

it('labels same-batch name conflicts, blocks writes, and clears the labels after renaming', async () => {
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) =>
    path === '/api/cats' && !init?.method ? response({ cats: [] }) : original(path, init),
  );
  await act(async () => root.render(<Harness />));
  const partner = setup.draft!.partners.find((partner) => partner.id === 'claude')!;
  await act(async () => setup.patchPartner(partner.id, { form: { ...partner.form, nickname: 'CodeAgent' } }));
  expect(
    setup.draft?.partners.filter((partner) => partner.identityConflict).map((partner) => partner.runtime.id),
  ).toEqual(['codeagent', 'claude']);
  expect(
    Array.from(container.querySelectorAll('[role="status"]')).filter((element) =>
      element.textContent?.includes('同名伙伴'),
    ),
  ).toHaveLength(2);
  await act(async () => setup.start());
  expect(setup.error).toContain('同名');
  expect(vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method)).toHaveLength(0);
  expect(onCreated).not.toHaveBeenCalled();
  await act(async () => setup.patchPartner(partner.id, { form: { ...partner.form, nickname: '独立伙伴' } }));
  expect(setup.draft?.partners.some((partner) => partner.identityConflict)).toBe(false);
  expect(
    Array.from(container.querySelectorAll('[role="status"]')).filter((element) =>
      element.textContent?.includes('同名伙伴'),
    ),
  ).toHaveLength(0);
});

it('allows creation after changing the new nickname and preserves the existing member', async () => {
  await act(async () => root.render(<Harness />));
  const partner = setup.draft!.partners.find((partner) => partner.id === 'claude')!;
  await act(async () => setup.patchPartner(partner.id, { selected: true }));
  await act(async () => setup.start());
  expect(setup.error).toContain('同名');
  await act(async () => setup.patchPartner(partner.id, { form: { ...partner.form, nickname: '新的伙伴' } }));
  vi.mocked(apiFetch).mockClear();
  await act(async () => setup.start());
  const writes = vi
    .mocked(apiFetch)
    .mock.calls.filter(([path, init]) => path === '/api/cats' && init?.method === 'POST');
  expect(writes).toHaveLength(1);
  expect(JSON.parse(String(writes[0][1]?.body))).toMatchObject({ nickname: '新的伙伴', clientId: 'anthropic' });
  expect(setup.draft?.partners.find((partner) => partner.existingId === existing.id)?.form).toMatchObject({
    nickname: '宪宪',
    defaultModel: 'user-model',
    avatar: '/custom-ragdoll.png',
  });
  expect(setup.error).toBe('');
  expect(onCreated).toHaveBeenCalledOnce();
});

it('normalizes whitespace and fullwidth nicknames when an edited selection is submitted', async () => {
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) =>
    path === '/api/cats' && !init?.method
      ? response({ cats: [{ ...existing, nickname: ' Alice ' }] })
      : original(path, init),
  );
  await act(async () => root.render(<Harness />));
  const partner = setup.draft!.partners.find((partner) => partner.id === 'claude')!;
  await act(async () =>
    setup.patchPartner(partner.id, { selected: true, form: { ...partner.form, nickname: '　ＡＬＩＣＥ　' } }),
  );
  await act(async () => setup.start());
  expect(setup.error).toContain('同名');
  expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});
