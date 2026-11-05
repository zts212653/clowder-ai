import { describe, expect, it } from 'vitest';
import { initialState } from '../hub-cat-editor.model';
import { buildCatPayload, buildMemberPatchPayload } from '../hub-cat-editor.payload';
import { requiredHubCatFields } from '../hub-cat-editor-required';
import { matchesRuntime, runtimeDefaults } from '../settings/members/member-runtime-draft';

describe('plugin client member binding', () => {
  it('the current settings editor keeps each plugin client as a distinct runtime choice', () => {
    const choice = (id: string) => ({
      id: `plugin:official.acp-clients/${id}`,
      label: id,
      installed: true,
      clientId: 'acp' as const,
      models: [],
      acp: { agentProvider: `plugin:official.acp-clients/${id}`, command: 'plugin-agent', startupArgs: [] },
    });
    const form = { ...initialState(), ...runtimeDefaults(choice('dsh')) };
    expect(form.acpAgentProvider).toBe('plugin:official.acp-clients/dsh');
    expect(form.mcpSupport).toBe(true);
    expect(matchesRuntime(form, choice('dsh'))).toBe(true);
    expect(matchesRuntime(form, choice('pi'))).toBe(false);
  });
  it('persists the reference without copying a launch command or requiring an account', () => {
    const form = {
      ...initialState(),
      clientId: 'acp' as const,
      carrier: 'acp' as const,
      configurationSource: 'native_tool' as const,
      acpAgentProvider: 'plugin:official.acp-clients/dsh',
      name: '测试',
      roleDescription: '测试角色',
      mentionPatterns: '@测试',
      catId: 'test-client',
      acpCommand: '',
      acpStartupArgs: '',
      accountRef: '',
    };
    expect(buildCatPayload(form)).toMatchObject({
      agentProvider: 'plugin:official.acp-clients/dsh',
      acp: { command: 'plugin-agent', startupArgs: [] },
    });
    expect(requiredHubCatFields(form, null, true).errors.account).toBeUndefined();
  });
  it('permits a standalone ACP executable with zero startup arguments', () => {
    const form = {
      ...initialState(),
      clientId: 'acp' as const,
      carrier: 'acp' as const,
      acpCommand: 'C:/Program Files/Agent/agent.exe',
      acpStartupArgs: '',
    };
    expect(buildCatPayload(form)).toMatchObject({ acp: { command: form.acpCommand, startupArgs: [] } });
  });
  it('switching to manual launch removes the old plugin binding', () => {
    const form = {
      ...initialState(),
      clientId: 'acp' as const,
      carrier: 'acp' as const,
      acpAgentProvider: null,
      acpCommand: 'agent.exe',
      acpStartupArgs: '',
    };
    const old = {
      id: 'test',
      displayName: 'Test',
      color: { primary: '#000000', secondary: '#ffffff' },
      mentionPatterns: ['@test'],
      clientId: 'acp',
      carrier: 'acp' as const,
      defaultModel: '',
      avatar: '/test.png',
      roleDescription: 'Test',
      personality: '',
      acp: { agentProvider: 'plugin:official.acp-clients/dsh', command: 'plugin-agent', startupArgs: [] },
    };
    expect(buildCatPayload(form, old)).toMatchObject({ acp: { command: 'agent.exe' } });
    expect(buildCatPayload(form, old)).toMatchObject({ agentProvider: null });
    expect(buildCatPayload(form, old)).not.toHaveProperty('acp.agentProvider');
    const legacy = { ...old, acp: { command: 'node', startupArgs: [] } };
    const legacyForm = initialState(legacy);
    expect(buildMemberPatchPayload({ ...legacyForm, name: '只改名' }, legacy)).not.toHaveProperty('agentProvider');
    expect(buildMemberPatchPayload({ ...legacyForm, acpCommand: 'new-agent.exe' }, legacy)).toMatchObject({
      agentProvider: null,
    });
  });
  it('an explicit native tool choice clears the legacy binding, but an untouched legacy form does not', () => {
    const native = runtimeDefaults({
      id: 'claude',
      label: 'Claude',
      clientId: 'anthropic',
      installed: true,
      models: [],
    });
    expect(buildCatPayload({ ...initialState(), ...native })).toMatchObject({ agentProvider: null, carrier: 'cli' });
    expect(buildCatPayload(initialState())).not.toHaveProperty('agentProvider');
  });
});
