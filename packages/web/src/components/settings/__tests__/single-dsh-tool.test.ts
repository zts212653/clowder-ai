import { expect, it } from 'vitest';
import { initialState } from '../../hub-cat-editor.model';
import { pickRuntime, type RuntimeChoice, switchMemberRuntime } from '../members/member-runtime-draft';
import { memberRuntimeTools } from '../members/member-runtime-tools';

const discovery: RuntimeChoice = {
  id: 'dsh-desktop',
  label: 'DSH Desktop',
  clientId: 'acp',
  installed: true,
  dshDesktop: true,
  models: [],
  acp: { command: '/desktop/dsh.cmd', startupArgs: ['--profile', 'acp'] },
};
const form = {
  ...initialState(),
  clientId: 'acp' as const,
  carrier: 'acp' as const,
  configurationSource: 'native_tool' as const,
  acpCommand: '/desktop/dsh.cmd',
  acpStartupArgs: '--profile acp --patch /own/member.yml',
  env: { DSH_HOME: '/own/home' },
  defaultModel: '["custom","chosen"]',
  cliEffort: 'high',
};
it('has one DSH choice bound to this form, never another member or retained launch', () => {
  const other = { ...discovery, id: 'acp:other', dshDesktop: undefined, env: { DSH_HOME: '/other/home' } };
  const hidden = {
    id: 'acp:hidden',
    label: 'DSH',
    clientId: 'acp' as const,
    installed: true,
    onboardingEligible: false,
    models: [],
  };
  const tools = memberRuntimeTools([other, discovery, hidden], [], { retained: pickRuntime(form) }, form);
  const dsh = tools.filter((item) => item.label.startsWith('DSH'));
  expect(dsh).toHaveLength(1);
  expect(dsh[0]).toMatchObject({
    id: 'dsh',
    env: form.env,
    acp: { startupArgs: ['--profile', 'acp', '--patch', '/own/member.yml'] },
  });
  expect(
    switchMemberRuntime({ version: 1, form, baseline: null, section: 'runtime', templateId: null }, dsh[0]).form,
  ).toEqual(form);
});
it('returns to the retained complete binding and works without Desktop discovery', () => {
  const draft = { version: 1 as const, form, baseline: null, section: 'runtime', templateId: null };
  const away = switchMemberRuntime(draft, {
    id: 'codex',
    label: 'Codex',
    clientId: 'openai',
    installed: true,
    models: [],
  });
  const tools = memberRuntimeTools([], [], away.runtimeDrafts, away.form);
  const dsh = tools.find((item) => item.id === 'dsh')!;
  expect(dsh).toBeDefined();
  expect(switchMemberRuntime(away, dsh).form).toMatchObject(pickRuntime(form));
  expect(memberRuntimeTools([], [], undefined, form).filter((item) => item.id === 'dsh')).toHaveLength(1);
  expect(tools.some((item) => item.id.startsWith('manual:') && item.acp?.command === '')).toBe(true);
});
it('keeps a backend-verified SDK binding unique when switching away and back without Desktop', () => {
  const sdkForm = { ...form, acpCommand: 'node', acpStartupArgs: '/installed/dsh/lib/bin.js --profile acp' };
  const sdk: RuntimeChoice = {
    ...discovery,
    id: 'acp:own',
    dshDesktop: undefined,
    dshSetupSupported: true,
    env: sdkForm.env,
    acp: { command: 'node', startupArgs: ['/installed/dsh/lib/bin.js', '--profile', 'acp'] },
  };
  const away = switchMemberRuntime(
    { version: 1, form: sdkForm, baseline: null, section: 'runtime', templateId: null },
    { id: 'codex', label: 'Codex', clientId: 'openai', installed: true, models: [] },
  );
  const tools = memberRuntimeTools([sdk], [], away.runtimeDrafts, away.form);
  const dsh = tools.find((item) => item.id === 'dsh')!;
  expect(dsh).toBeDefined();
  expect(tools.some((item) => item.id.startsWith('draft:') && item.acp?.command === 'node')).toBe(false);
  expect(switchMemberRuntime(away, dsh).form).toMatchObject(pickRuntime(sdkForm));
});
