import { expect, it } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { recommendNativePartners } from '../first-run-quest/native-onboarding';
import type { TemplateCard } from '../first-run-quest/TemplateStep';
import { initialState } from '../hub-cat-editor.model';
import type { MemberDraft } from '../settings/members/member-editor-state';
import { memberRuntimeContextScope } from '../settings/members/member-runtime-context';
import { type RuntimeChoice, runtimeDefaults, switchMemberRuntime } from '../settings/members/member-runtime-draft';
import { memberRuntimeOptions, memberRuntimeTools } from '../settings/members/member-runtime-tools';

const codeagent = {
  id: 'codeagent',
  label: 'CodeAgent',
  harnessId: 'codeagent',
  kind: 'tool',
  clientId: 'acp',
  installed: true,
  models: [],
  acp: { command: 'codeagent', startupArgs: ['--acp'], transport: 'stdio' },
  roleTemplates: ['ragdoll', 'maine-coon', 'turkish-van'].map((id) => ({ id, priority: 100 })),
} as RuntimeChoice;
const tools = [
  codeagent,
  ...[
    ['claude', 'Claude Code', 'anthropic', 'claudecode'],
    ['codex', 'Codex', 'openai', 'codex'],
    ['dsh', 'DSH', 'acp', 'dsh'],
    ['pi', 'Pi', 'acp', 'pi'],
    ['kimi', 'Kimi', 'kimi', 'kimi'],
  ].map(
    ([id, label, clientId, harnessId]) =>
      ({ id, label, clientId, harnessId, kind: 'tool', installed: true, models: [] }) as RuntimeChoice,
  ),
];
const binding = {
  ...codeagent,
  id: 'acp:saved-role',
  kind: 'binding',
  sourceCatId: 'saved-role',
  label: '缅因猫',
  roleTemplates: undefined,
  acp: { command: 'codeagent', startupArgs: ['--acp', '--permission-mode', 'bypassPermission'], transport: 'stdio' },
} as RuntimeChoice;
const library = {
  pluginId: 'approved-plugin',
  configurationKey: null,
  clients: [{ id: 'client', name: 'Private CodeAgent', ref: 'plugin:approved-plugin:client', available: false }],
};
const t = (zh: string) => zh;

it('separates the five intranet harnesses from exact bindings and plugin authorization', () => {
  const result = memberRuntimeTools([...tools, binding], [library], undefined, 'intranet');
  const ordinary = memberRuntimeOptions(result, t, 'tools');
  expect(ordinary.map((item) => item.label.split(' · ')[0])).toEqual([
    'CodeAgent',
    'Claude Code',
    'Codex',
    'DSH',
    'Pi',
  ]);
  expect(ordinary.some((item) => /宪宪|砚砚|墨墨|布偶猫|缅因猫/.test(item.label))).toBe(false);
  const configurations = memberRuntimeOptions(result, t, 'bindings');
  expect(configurations.find((item) => item.value === binding.id)?.label).toContain('CodeAgent');
  expect(configurations.find((item) => item.value === binding.id)?.label).not.toContain('缅因猫');
  expect(configurations.find((item) => item.value === library.clients[0].ref)?.disabled).toBe(true);
  expect(result.find((item) => item.id === binding.id)?.acp).toEqual(binding.acp);
  expect(result.find((item) => item.id === library.clients[0].ref)?.acp?.agentProvider).toBe(library.clients[0].ref);
});

it('retains public manual clients and keeps unknown custom bindings available separately', () => {
  const unknown = {
    ...binding,
    id: 'acp:wrapper',
    label: '布偶猫',
    harnessId: undefined,
    acp: { command: 'private-wrapper', startupArgs: ['--acp'] },
  } as RuntimeChoice;
  const result = memberRuntimeTools([...tools, unknown], [], undefined, 'public');
  expect(memberRuntimeOptions(result, t).some((item) => item.label.startsWith('Gemini'))).toBe(true);
  expect(memberRuntimeOptions(result, t, 'bindings').find((item) => item.value === unknown.id)?.label).not.toContain(
    '布偶猫',
  );
});

it('keeps exact settings on same-harness selection and restores them after a tool round trip', () => {
  const form = {
    ...initialState(),
    ...runtimeDefaults(binding),
    name: 'My role',
    defaultModel: 'private-model',
    cliEffort: 'high',
  };
  const draft: MemberDraft = { version: 1, form, baseline: null, templateId: null, section: 'runtime' };
  expect(switchMemberRuntime(draft, codeagent, binding)).toBe(draft);
  const codex = tools.find((item) => item.id === 'codex');
  if (!codex) throw Error('Codex fixture missing');
  const away = switchMemberRuntime(draft, codex, binding);
  const restored = switchMemberRuntime(away, codeagent, codex);
  expect(restored.form).toEqual(form);
  expect(restored.form.name).toBe('My role');
});

it('restores the most recently used exact configuration when a harness has several retained bindings', () => {
  const codex = tools.find((item) => item.id === 'codex');
  if (!codex) throw Error('Codex fixture missing');
  const other = {
    ...binding,
    id: 'acp:other',
    acp: { command: 'codeagent', startupArgs: ['--acp', '--other-config'] },
  };
  const original: MemberDraft = {
    version: 1,
    baseline: null,
    templateId: null,
    section: 'runtime',
    form: { ...initialState(), ...runtimeDefaults(binding), defaultModel: 'model-A' },
  };
  const firstOther = switchMemberRuntime(original, other, binding);
  const away = switchMemberRuntime(
    { ...firstOther, form: { ...firstOther.form, defaultModel: 'model-B' } },
    codex,
    other,
  );
  const explicitOriginal = switchMemberRuntime(away, binding, codex);
  const awayAgain = switchMemberRuntime(explicitOriginal, codex, binding);
  expect(switchMemberRuntime(awayAgain, codeagent, codex).form).toEqual(original.form);
});

it('does not equate a plugin grant with a native harness sharing its executable', () => {
  const plugin = {
    ...binding,
    id: library.clients[0].ref,
    acp: { command: 'codeagent', startupArgs: ['--acp'], agentProvider: library.clients[0].ref },
  };
  const draft: MemberDraft = {
    version: 1,
    form: { ...initialState(), ...runtimeDefaults(plugin) },
    baseline: null,
    templateId: null,
    section: 'runtime',
  };
  const switched = switchMemberRuntime(draft, codeagent, plugin);
  expect(switched.form.acpAgentProvider).toBeNull();
  expect(switched.form.acpStartupArgs).toBe('--acp');
});

it('expands role recommendations separately while preserving all three established identities and keys', () => {
  const names = ['宪宪', '砚砚', '墨墨'];
  const templates = ['ragdoll', 'maine-coon', 'turkish-van'].map((id, index) => ({
    id,
    name: ['布偶猫', '缅因猫', '梵花猫'][index],
    nickname: names[index],
    avatar: '/avatars/default.png',
    color: { primary: '#111111', secondary: '#eeeeee' },
    roleDescription: `role-${id}`,
    personality: `personality-${id}`,
  })) as TemplateCard[];
  const legacy = templates.map((template) => ({
    ...codeagent,
    roleTemplates: undefined,
    id: `codeagent:${template.id}`,
    label: `CodeAgent · ${template.nickname}`,
    roleTemplateId: template.id,
    priority: 100,
  }));
  const before = recommendNativePartners(legacy, templates, [], 'same-journey');
  const after = recommendNativePartners([codeagent, binding], templates, [], 'same-journey');
  expect(after).toHaveLength(3);
  expect(after.map((partner) => partner.form.nickname)).toEqual(names);
  expect(after.map((partner) => partner.form.roleDescription)).toEqual(
    templates.map((template) => template.roleDescription),
  );
  expect(after.map((partner) => partner.id)).toEqual(before.map((partner) => partner.id));
  expect(after.map((partner) => partner.form.catId)).toEqual(before.map((partner) => partner.form.catId));
  expect(after.map((partner) => partner.runtime.label)).toEqual(['CodeAgent', 'CodeAgent', 'CodeAgent']);
});

it('prefers an existing role binding over newly discovered harness defaults', () => {
  const existing = {
    id: 'codeagent-ragdoll',
    name: '布偶猫',
    displayName: '布偶猫',
    nickname: '宪宪',
    clientId: 'acp',
    carrier: 'acp',
    configurationSource: 'native_tool',
    defaultModel: 'company-model',
    mentionPatterns: ['@宪宪'],
    color: { primary: '#111111', secondary: '#eeeeee' },
    acp: binding.acp,
  } as CatData;
  const storedBinding = { ...binding, sourceCatId: existing.id, id: `acp:${existing.id}` };
  const before = structuredClone(existing);
  const partner = recommendNativePartners([codeagent, storedBinding], [], [existing], 'same-journey').find(
    (item) => item.runtime.roleTemplateId === 'ragdoll',
  );
  expect(partner?.existingId).toBe(existing.id);
  expect(partner?.form.defaultModel).toBe('company-model');
  expect(partner?.form.acpStartupArgs).toContain('bypassPermission');
  expect(existing).toEqual(before);
});

it('keeps ordinary native member IDs, aliases and role keys unchanged after catalog enrichment', () => {
  const ordinary = tools.filter((item) => item.harnessId !== 'codeagent');
  const old = ordinary.map((runtime) => ({ ...runtime, kind: undefined, harnessId: undefined }));
  const before = recommendNativePartners(old, [], [], 'native-identities');
  const after = recommendNativePartners(ordinary, [], [], 'native-identities');
  expect(after.map((partner) => [partner.id, partner.form.catId, partner.form.mentionPatterns])).toEqual(
    before.map((partner) => [partner.id, partner.form.catId, partner.form.mentionPatterns]),
  );
  expect(after.every((partner) => !partner.form.catId.startsWith('codeagent-'))).toBe(true);
  expect(after.find((partner) => partner.runtime.id === 'dsh')?.form.catId).toBe('dsh');
  expect(after.find((partner) => partner.runtime.id === 'codex')?.form.catId).toBe('codex');
});

it('keeps context only within the same member, executable, transport and plugin grant', () => {
  const form = { ...initialState(), ...runtimeDefaults(binding), catId: 'same-member' };
  const scope = memberRuntimeContextScope(form);
  expect(memberRuntimeContextScope({ ...form, acpStartupArgs: '--acp --another-preference' })).toBe(scope);
  for (const change of [
    { catId: 'other-member' },
    { acpCommand: 'other.exe' },
    { acpTransport: 'httpstream' as const },
    { acpAgentProvider: 'plugin:another:grant' },
  ])
    expect(memberRuntimeContextScope({ ...form, ...change })).not.toBe(scope);
  const node = { ...form, acpCommand: 'node', acpStartupArgs: 'dsh.mjs --profile acp' };
  expect(memberRuntimeContextScope({ ...node, acpStartupArgs: 'pi.mjs --profile acp' })).not.toBe(
    memberRuntimeContextScope(node),
  );
});
