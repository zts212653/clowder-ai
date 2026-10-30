import { expect, it } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import type { RuntimeChoice } from '../../settings/members/member-runtime-draft';
import { recommendNativePartners } from '../native-onboarding';
import { parkedNativePartners } from '../native-runtime-recommendations';
import type { TemplateCard } from '../TemplateStep';

const templates: TemplateCard[] = ['ragdoll', 'maine-coon', 'turkish-van'].map((id, index) => ({
  id,
  name: ['布偶猫', '缅因猫', '梵花猫'][index],
  nickname: ['宪宪', '砚砚', '墨墨'][index],
  avatar: `/avatars/${id}.png`,
  color: { primary: '#111111', secondary: '#eeeeee' },
  roleDescription: `role-${id}`,
  personality: `personality-${id}`,
}));
const codeagent: RuntimeChoice = {
  id: 'codeagent',
  kind: 'tool',
  harnessId: 'codeagent',
  label: 'CodeAgent',
  clientId: 'acp',
  installed: true,
  models: [],
  acp: { command: 'codeagent', startupArgs: ['--acp'], transport: 'stdio' },
  roleTemplates: templates.map((template) => ({ id: template.id, priority: 100 })),
};
const claude: RuntimeChoice = {
  id: 'claude',
  kind: 'tool',
  harnessId: 'claudecode',
  label: 'Claude Code',
  clientId: 'anthropic',
  installed: true,
  models: [],
  readiness: { status: 'configured', checkedAt: 1 },
};
const tools: RuntimeChoice[] = [
  codeagent,
  claude,
  { id: 'codex', kind: 'tool', harnessId: 'codex', label: 'Codex', clientId: 'openai', installed: true, models: [] },
  {
    id: 'pi',
    kind: 'tool',
    harnessId: 'pi',
    label: 'Pi',
    clientId: 'acp',
    installed: true,
    models: [],
    acp: { command: 'pi-acp', startupArgs: [] },
  },
];
const recommend = (runtimes = tools, cats: CatData[] = []) =>
  recommendNativePartners(runtimes, templates, cats, 'intranet-journey', 'intranet');

it('recommends one Claude Xianxian and one CodeAgent Yanyan when all clients are installed', () => {
  const result = recommend();
  expect(result.map((partner) => [partner.runtime.harnessId, partner.form.nickname]).sort()).toEqual([
    ['claudecode', '宪宪'],
    ['codeagent', '砚砚'],
  ]);
  expect(result.every((partner) => partner.selected)).toBe(true);
  expect(new Set(result.map((partner) => partner.form.nickname)).size).toBe(result.length);
});

it('CodeAgent remains Yanyan when Claude is absent and old three-role discovery is returned', () => {
  const legacy = templates.map((template) => ({
    ...codeagent,
    roleTemplates: undefined,
    id: `codeagent:${template.id}`,
    roleTemplateId: template.id,
    label: `CodeAgent · ${template.nickname}`,
  }));
  const result = recommend(legacy);
  expect(result).toHaveLength(1);
  expect(result[0].form.nickname).toBe('砚砚');
  expect(result[0].selected).toBe(true);
});

it('does not create another identity already occupied by a manually configured member', () => {
  const cats = [
    {
      id: 'manual-yan',
      displayName: '我的缅因',
      nickname: '砚砚',
      clientId: 'openai',
      carrier: 'app_server',
      mentionPatterns: ['@砚砚'],
      color: { primary: '#111111', secondary: '#eeeeee' },
    },
  ] as CatData[];
  const before = structuredClone(cats);
  expect(recommend(tools, cats).map((partner) => partner.form.nickname)).toEqual(['宪宪']);
  expect(cats).toEqual(before);
});

it('keeps an existing CodeAgent role and its exact configuration rather than recreating it', () => {
  const cats = [
    {
      id: 'codeagent-maine-coon',
      displayName: '我的缅因',
      nickname: '砚砚',
      clientId: 'acp',
      carrier: 'acp',
      configurationSource: 'native_tool',
      defaultModel: 'company-model',
      mentionPatterns: ['@砚砚'],
      color: { primary: '#111111', secondary: '#eeeeee' },
      acp: { command: 'D:/enterprise/codeagent.exe', startupArgs: ['--acp', '--custom'], transport: 'stdio' },
    },
  ] as CatData[];
  const binding: RuntimeChoice = {
    ...codeagent,
    id: 'acp:codeagent-maine-coon',
    kind: 'binding',
    sourceCatId: cats[0].id,
    acp: cats[0].acp,
  };
  const before = structuredClone(cats);
  const result = recommend([...tools, binding], cats);
  const partner = result.find((item) => item.runtime.harnessId === 'codeagent');
  expect(partner?.existingId).toBe(cats[0].id);
  expect(partner?.form.defaultModel).toBe('company-model');
  expect(partner?.form.acpCommand).toBe('D:/enterprise/codeagent.exe');
  expect(partner?.form.acpStartupArgs).toContain('--custom');
  expect(cats).toEqual(before);
});

it('does not change public recommendations or remove Codex and Pi from the actual tool catalog', () => {
  const before = structuredClone(tools);
  expect(recommendNativePartners(tools, templates, [], 'public-journey').some((p) => p.runtime.id === 'codex')).toBe(
    true,
  );
  recommend();
  expect(tools).toEqual(before);
});

it('retains other old role forms even when an earlier release gave them the same retry key', () => {
  const previous = recommendNativePartners([codeagent], templates, [], 'old-shared-key').map((partner) => ({
    ...partner,
    creationRequestKey: 'legacy-shared-key',
  }));
  const yanyan = previous.find((partner) => partner.runtime.roleTemplateId === 'maine-coon');
  if (!yanyan) throw Error('Yanyan recommendation missing');
  const parked = parkedNativePartners(previous, [yanyan]);
  expect(parked.map((partner) => partner.form.nickname)).toEqual(['宪宪', '墨墨']);
  expect(parked.every((partner) => partner.creationRequestKey === 'legacy-shared-key')).toBe(true);
});
