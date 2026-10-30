import { expect, it } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import type { RuntimeChoice } from '../../settings/members/member-runtime-draft';
import { recommendNativePartners } from '../native-onboarding';
import type { TemplateCard } from '../TemplateStep';

const templates: TemplateCard[] = ['ragdoll', 'maine-coon', 'turkish-van'].map((id, index) => ({
  id,
  name: ['布偶猫', '缅因猫', '梵花猫'][index],
  nickname: ['宪宪', '砚砚', '墨墨'][index],
  avatar: `/avatars/${id}.png`,
  color: { primary: '#111111', secondary: '#eeeeee' },
  roleDescription: `role-${id}`,
  personality: `personality-${id}`,
  teamStrengths: `strength-${id}`,
}));
const runtimes: RuntimeChoice[] = templates.map((template) => ({
  id: `codeagent:${template.id}`,
  label: `CodeAgent · ${template.nickname}`,
  clientId: 'acp',
  installed: true,
  models: [],
  roleTemplateId: template.id,
  priority: 100,
  acp: { command: 'codeagent', startupArgs: ['--acp'], transport: 'stdio' },
}));

it('one detected CodeAgent creates three distinct established identities even with no Claude installation', () => {
  const partners = recommendNativePartners(runtimes, templates, [], 'intranet');
  expect(partners).toHaveLength(3);
  expect(partners.map((partner) => partner.form.nickname)).toEqual(['宪宪', '砚砚', '墨墨']);
  expect(new Set(partners.map((partner) => partner.id)).size).toBe(3);
  expect(new Set(partners.map((partner) => partner.form.catId)).size).toBe(3);
  for (const partner of partners) {
    expect(partner.selected).toBe(true);
    expect(partner.form.acpCommand).toBe('codeagent');
  }
});

it('an existing identity is not silently rebound or duplicated by a higher priority discovery', () => {
  const original = {
    id: 'existing-xian',
    displayName: '布偶猫',
    nickname: '宪宪',
    clientId: 'anthropic',
    carrier: 'cli',
    configurationSource: 'native_tool',
    defaultModel: '',
    mentionPatterns: ['@宪宪'],
    color: { primary: '#111111', secondary: '#eeeeee' },
  } as CatData;
  const before = structuredClone(original);
  const partners = recommendNativePartners(runtimes, templates, [original], 'intranet');
  expect(partners.find((partner) => partner.runtime.roleTemplateId === 'ragdoll')?.selected).toBe(false);
  expect(original).toEqual(before);
  expect(partners.filter((partner) => partner.selected).map((partner) => partner.form.nickname)).toEqual([
    '砚砚',
    '墨墨',
  ]);
});

it('CodeAgent has selection priority for the same role while the native client remains optional', () => {
  const claude: RuntimeChoice = {
    id: 'claude',
    label: 'Claude Code',
    clientId: 'anthropic',
    installed: true,
    models: [],
    readiness: { status: 'configured', checkedAt: 1 },
  };
  const partners = recommendNativePartners([claude, ...runtimes], templates, [], 'intranet');
  expect(partners[0].runtime.id).toBe('codeagent:ragdoll');
  expect(partners.find((partner) => partner.runtime.id === 'claude')?.selected).toBe(false);
});
