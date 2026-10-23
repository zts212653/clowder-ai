import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { useNativeOnboarding } from '../useNativeOnboarding';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ refresh: vi.fn() }) }));

it('narrows legacy intranet drafts to Yanyan while parking other identities and retry receipts without writes', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  const templates = ['ragdoll', 'maine-coon', 'turkish-van'].map((id, index) => ({
    id,
    name: ['布偶猫', '缅因猫', '梵花猫'][index],
    nickname: ['宪宪', '砚砚', '墨墨'][index],
    avatar: '/avatars/default.png',
    color: { primary: '#111111', secondary: '#eeeeee' },
    roleDescription: `role-${id}`,
    personality: `personality-${id}`,
  }));
  const canonical = {
    id: 'codeagent',
    kind: 'tool',
    harnessId: 'codeagent',
    label: 'CodeAgent',
    clientId: 'acp',
    installed: true,
    models: [],
    acp: { command: 'codeagent', startupArgs: ['--acp'], transport: 'stdio' },
    roleTemplates: [{ id: 'maine-coon', priority: 100 }],
  };
  let upgraded = false;
  let state: ReturnType<typeof useNativeOnboarding> | undefined;
  function Harness() {
    state = useNativeOnboarding(true, vi.fn(), 'members');
    return null;
  }
  vi.mocked(apiFetch).mockImplementation(
    async (path) =>
      new Response(
        JSON.stringify(
          String(path).startsWith('/api/cats/native-runtimes')
            ? {
                edition: upgraded ? 'intranet' : 'public',
                runtimes: upgraded
                  ? [canonical]
                  : templates.map((template) => ({
                      ...canonical,
                      roleTemplates: undefined,
                      id: `codeagent:${template.id}`,
                      label: `CodeAgent · ${template.nickname}`,
                      roleTemplateId: template.id,
                      priority: 100,
                    })),
              }
            : path === '/api/session'
              ? { userId: 'harness-upgrade' }
              : path === '/api/cat-templates'
                ? { templates }
                : { cats: [] },
        ),
      ),
  );
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Harness />));
    const first = state?.draft?.partners[0];
    if (!first) throw Error('Initial recommendation missing');
    const third = state?.draft?.partners[2];
    if (!third) throw Error('Third recommendation missing');
    await act(async () => state?.patch({ lead: third.id }));
    await act(async () =>
      state?.patchPartner(first.id, {
        selected: false,
        form: {
          ...first.form,
          nickname: '我的宪宪',
          defaultModel: 'company-model',
          acpStartupArgs: '--acp --custom-preference',
        },
      }),
    );
    const before = structuredClone(state?.draft?.partners);
    upgraded = true;
    await act(async () => state?.reload());
    expect(state?.draft?.partners).toHaveLength(1);
    expect(state?.draft?.partners[0].form.nickname).toBe('砚砚');
    expect(state?.draft?.lead).toBe(state?.draft?.partners[0].id);
    expect(
      [...(state?.draft?.partners ?? []), ...(state?.draft?.parkedPartners ?? [])]
        .map((partner) => ({
          id: partner.id,
          form: partner.form,
          key: partner.creationRequestKey,
          selected: partner.selected,
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    ).toEqual(
      before
        ?.map((partner) => ({
          id: partner.id,
          form: partner.form,
          key: partner.creationRequestKey,
          selected: partner.selected,
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    );
    expect(state?.draft?.partners[0].runtime.label).toBe('CodeAgent');
    expect(state?.draft?.parkedPartners).toHaveLength(2);
    const parked = structuredClone(state?.draft?.parkedPartners);
    await act(async () => state?.reload());
    expect(state?.draft?.parkedPartners).toEqual(parked);
    expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => ['POST', 'PATCH'].includes(init?.method ?? ''))).toBe(
      false,
    );
  } finally {
    await act(async () => root.unmount());
    host.remove();
    localStorage.clear();
    vi.resetAllMocks();
    vi.unstubAllGlobals();
  }
});
