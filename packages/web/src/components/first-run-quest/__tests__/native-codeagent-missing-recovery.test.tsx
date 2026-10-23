import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { initialState } from '../../hub-cat-editor.model';
import { retainedCodeagentDraft } from '../native-codeagent-draft-recovery';
import type { NativePartner } from '../native-onboarding';
import { useNativeOnboarding } from '../useNativeOnboarding';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ refresh: vi.fn() }) }));

it('retains pending CodeAgent Yanyan and parks other roles through missing-CLI migration and reinstall without execution', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  const roles = ['ragdoll', 'maine-coon', 'turkish-van'];
  const templates = roles.map((id, index) => ({
    id,
    name: ['布偶猫', '缅因猫', '梵花猫'][index],
    nickname: ['宪宪', '砚砚', '墨墨'][index],
    avatar: '/avatars/default.png',
    color: { primary: '#111111', secondary: '#eeeeee' },
    roleDescription: `role-${id}`,
    personality: `personality-${id}`,
  }));
  let discovery: 'legacy' | 'missing' | 'reinstalled' = 'legacy';
  const canonical = {
    id: 'codeagent',
    kind: 'tool',
    harnessId: 'codeagent',
    label: 'CodeAgent',
    clientId: 'acp',
    models: [],
    roleTemplates: roles.map((id) => ({ id, priority: 100 })),
  };
  function discoveredRuntimes() {
    if (discovery === 'legacy')
      return roles.map((id) => ({
        id: `codeagent:${id}`,
        label: `CodeAgent · ${id}`,
        clientId: 'acp',
        roleTemplateId: id,
        priority: 100,
        installed: true,
        models: [],
        acp: { command: 'codeagent', startupArgs: ['--acp'] },
      }));
    return [
      {
        ...canonical,
        installed: discovery === 'reinstalled',
        ...(discovery === 'reinstalled'
          ? { acp: { command: 'D:/reinstalled/codeagent.exe', startupArgs: ['--acp'] } }
          : {}),
      },
    ];
  }
  vi.mocked(apiFetch).mockImplementation(
    async (path) =>
      new Response(
        JSON.stringify(
          String(path).startsWith('/api/cats/native-runtimes')
            ? {
                edition: discovery === 'legacy' ? 'public' : 'intranet',
                runtimes: discoveredRuntimes(),
              }
            : path === '/api/session'
              ? { userId: 'missing-codeagent' }
              : path === '/api/cat-templates'
                ? { templates }
                : { cats: [] },
        ),
      ),
  );
  let setup: ReturnType<typeof useNativeOnboarding> | undefined;
  function Harness() {
    setup = useNativeOnboarding(true, vi.fn(), 'members');
    return null;
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Harness />));
    const initial = setup?.draft?.partners;
    if (!initial || initial.length !== 3) throw Error('Three legacy roles missing');
    for (const [index, partner] of initial.entries())
      await act(async () =>
        setup?.patchPartner(partner.id, {
          form: {
            ...partner.form,
            nickname: `saved-${index}`,
            acpCommand: `saved-command-${index}`,
            acpStartupArgs: `--acp --saved-${index}`,
            defaultModel: `saved-model-${index}`,
          },
        }),
      );
    await act(async () => setup?.patch({ lead: initial[2].id }));
    const before = structuredClone(setup?.draft?.partners);
    const preserved = () =>
      [...(setup?.draft?.partners ?? []), ...(setup?.draft?.parkedPartners ?? [])]
        .map((partner) => ({
          id: partner.id,
          form: partner.form,
          key: partner.creationRequestKey,
        }))
        .sort((left, right) => left.id.localeCompare(right.id));
    const expected = before
      ?.map((partner) => ({
        id: partner.id,
        form: partner.form,
        key: partner.creationRequestKey,
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
    discovery = 'missing';
    await act(async () => setup?.reload());
    expect(preserved()).toEqual(expected);
    expect(setup?.draft?.partners).toHaveLength(1);
    expect(setup?.draft?.parkedPartners).toHaveLength(2);
    expect(setup?.draft?.lead).toBe('');
    expect(
      setup?.draft?.partners.every(
        (partner) => !partner.runtime.installed && !partner.runtime.acp && !partner.selected,
      ),
    ).toBe(true);
    await act(async () => setup?.start());
    expect(vi.mocked(apiFetch).mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
    expect(vi.mocked(apiFetch).mock.calls.some(([path]) => path === '/api/cats/runtime-models')).toBe(false);
    discovery = 'reinstalled';
    await act(async () => setup?.reload());
    await act(async () => setup?.reload());
    expect(preserved()).toEqual(expected);
    expect(setup?.draft?.lead).toBe(setup?.draft?.partners[0].id);
    expect(setup?.draft?.partners.every((partner) => partner.runtime.installed)).toBe(true);
    expect(
      new Set(
        [...(setup?.draft?.partners ?? []), ...(setup?.draft?.parkedPartners ?? [])].map((p) => p.creationRequestKey),
      ).size,
    ).toBe(3);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    localStorage.clear();
    vi.resetAllMocks();
    vi.unstubAllGlobals();
  }
});

it('refuses ambiguous roles, other harnesses and plugin grants despite identical launch descriptors', () => {
  const form = { ...initialState(), clientId: 'acp' as const, configurationSource: 'native_tool' as const };
  const old: NativePartner = {
    id: 'legacy-role',
    form,
    selected: true,
    creationRequestKey: 'pending-key',
    runtime: {
      id: 'codeagent:ragdoll',
      label: 'CodeAgent',
      clientId: 'acp',
      roleTemplateId: 'ragdoll',
      installed: true,
      models: [],
      acp: { command: 'codeagent', startupArgs: ['--acp'] },
    },
  };
  const next: NativePartner = {
    ...old,
    id: 'new-role',
    runtime: { ...old.runtime, id: 'codeagent', harnessId: 'codeagent', installed: false, acp: undefined },
  };
  expect(retainedCodeagentDraft(next, [old])?.previous).toBe(old);
  expect(retainedCodeagentDraft(next, [old, { ...old, id: 'another-pending-role' }])).toBeUndefined();
  expect(
    retainedCodeagentDraft(next, [{ ...old, runtime: { ...old.runtime, id: 'dsh', harnessId: 'dsh' } }]),
  ).toBeUndefined();
  expect(
    retainedCodeagentDraft(next, [{ ...old, form: { ...form, acpAgentProvider: 'plugin:approved:client' } }]),
  ).toBeUndefined();
  expect(
    retainedCodeagentDraft({ ...next, runtime: { ...next.runtime, roleTemplateId: 'arbitrary-role' } }, [old]),
  ).toBeUndefined();
});
