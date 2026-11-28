import { beforeEach, expect, it, vi } from 'vitest';
import { useMemberModelCatalogs } from '@/lib/member-model-display';
import { apiFetch } from '@/utils/api-client';
import { buildNativeCreationPayload } from '../../first-run-quest/native-creation-payload';
import { initialState } from '../../hub-cat-editor.model';
import { buildCatPayload } from '../../hub-cat-editor.payload';
import { needsDshPreparation, prepareNativeMember } from '../members/prepare-native-member';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
const runtime = {
  id: 'dsh',
  dshDesktop: true,
  installed: true,
  acp: { command: '/desktop/dsh.cmd', startupArgs: ['--profile', 'acp'] },
};
beforeEach(() => {
  vi.resetAllMocks();
  useMemberModelCatalogs.setState({ runtimes: [{ ...runtime, label: 'DSH Desktop', clientId: 'acp', models: [] }] });
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    if (url.endsWith('/agent-access/v1/detect'))
      return Response.json({ readiness: { state: 'ready' }, candidates: [runtime] });
    if (url.endsWith('/inspect'))
      return Response.json({
        revision: 'revision',
        provider: 'official',
        model: 'flash',
        providers: [
          { id: 'official', credential: 'configured', models: [{ id: 'flash' }] },
          { id: 'custom', credential: 'configured', models: [{ id: 'selected' }] },
        ],
      });
    if (url.endsWith('/prepare'))
      return Response.json({
        command: '/desktop/dsh.cmd',
        startupArgs: ['--profile', 'acp', '--patch', '/private/member.yml'],
        env: { DSH_HOME: '/private/home' },
        provider: 'custom',
        model: 'selected',
      });
    throw Error(`Unexpected request: ${url}`);
  });
});
it('prepares the selected route into the final save form without testing the model', async () => {
  const form = {
    ...initialState(),
    clientId: 'acp' as const,
    carrier: 'acp' as const,
    configurationSource: 'native_tool' as const,
    acpCommand: '/desktop/dsh.cmd',
    acpStartupArgs: '--profile acp',
    defaultModel: '["custom","selected"]',
    cliEffort: 'high',
    env: { HTTPS_PROXY: 'http://proxy.fixture' },
  };
  const result = await prepareNativeMember(form);
  expect(result).toMatchObject({
    defaultModel: form.defaultModel,
    cliEffort: 'high',
    env: { DSH_HOME: '/private/home', HTTPS_PROXY: 'http://proxy.fixture' },
  });
  expect(result.acpStartupArgs).toContain('/private/member.yml');
  const calls = vi.mocked(apiFetch).mock.calls;
  expect(calls.some(([url]) => url.endsWith('/test'))).toBe(false);
  expect(JSON.parse(String(calls.find(([url]) => url.endsWith('/prepare'))?.[1]?.body))).toMatchObject({
    provider: 'custom',
    model: 'selected',
  });
});
it('prepares the selected independent DSH binding before the shared Desktop with the same command', async () => {
  const ref = 'plugin:official.agent-dsh/dsh';
  const adapter = { ...runtime, id: ref, acp: { ...runtime.acp, agentProvider: ref } };
  const respond = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation((url, ...args) =>
    url.endsWith('/agent-access/v1/detect')
      ? Promise.resolve(Response.json({ readiness: { state: 'ready' }, candidates: [runtime, adapter] }))
      : respond(url, ...args),
  );
  const result = await prepareNativeMember(
    {
      ...initialState(),
      clientId: 'acp',
      carrier: 'acp',
      configurationSource: 'native_tool',
      acpCommand: runtime.acp.command,
      acpStartupArgs: '--profile acp',
      acpAgentProvider: ref,
      defaultModel: '["custom","selected"]',
    },
    undefined,
    { ...adapter, label: 'Independent DSH', clientId: 'acp', models: [] },
  );
  expect(result.acpAgentProvider).toBe(ref);
  const binding = {
    agentProvider: ref,
    acp: {
      command: '/desktop/dsh.cmd',
      startupArgs: ['--profile', 'acp', '--patch', '/private/member.yml'],
    },
    env: { DSH_HOME: '/private/home' },
  };
  expect(buildNativeCreationPayload(result)).toMatchObject(binding);
  expect(buildCatPayload(result)).toMatchObject(binding);
  expect(buildCatPayload({ ...result, acpAgentProvider: 'plugin:fixture.acp/agent' })).toMatchObject({
    acp: { command: 'plugin-agent', startupArgs: [] },
  });
  for (const [url, request] of vi.mocked(apiFetch).mock.calls) {
    if (url.endsWith('/inspect') || url.endsWith('/prepare'))
      expect(JSON.parse(String(request?.body)).runtimeId).toBe(ref);
  }
});

it('does not inspect or prepare an unchanged existing binding', async () => {
  const cat = {
    id: 'old',
    displayName: 'Old Whale',
    carrier: 'acp' as const,
    avatar: '',
    roleDescription: '',
    personality: '',
    color: { primary: '#123456', secondary: '#abcdef' },
    mentionPatterns: [],
    clientId: 'acp',
    configurationSource: 'native_tool' as const,
    acp: { command: '/manual/dsh.cmd', startupArgs: ['--profile', 'acp'] },
    defaultModel: 'old',
  };
  const form = { ...initialState(cat), displayName: 'Renamed' };
  expect(await prepareNativeMember(form, cat)).toBe(form);
  expect(apiFetch).not.toHaveBeenCalled();
});
it('does not replace an unavailable explicitly selected model with a default', async () => {
  const form = {
    ...initialState(),
    clientId: 'acp' as const,
    carrier: 'acp' as const,
    configurationSource: 'native_tool' as const,
    acpCommand: '/desktop/dsh.cmd',
    acpStartupArgs: '--profile acp',
    defaultModel: '["custom","gone"]',
  };
  await expect(prepareNativeMember(form)).rejects.toThrow('模型');
  expect(vi.mocked(apiFetch).mock.calls.some(([url]) => url.endsWith('/prepare'))).toBe(false);
});

it.each([
  'dsh',
  'node',
])('keeps existing CLI/SDK %s model, effort and pool edits independent of Desktop', async (command) => {
  const cat = {
    id: 'cli-whale',
    displayName: 'CLI Whale',
    carrier: 'acp' as const,
    avatar: '',
    roleDescription: '',
    personality: '',
    color: { primary: '#123456', secondary: '#abcdef' },
    mentionPatterns: [],
    clientId: 'acp',
    configurationSource: 'native_tool' as const,
    acp: {
      command,
      startupArgs: [
        ...(command === 'node' ? ['/sdk/node_modules/@deepseek-ai/dsh/lib/bin.js'] : []),
        '--profile',
        'acp',
      ],
    },
    defaultModel: 'old',
    env: { DSH_HOME: '/owner/cli-home' },
  };
  const form = { ...initialState(cat), defaultModel: 'new', cliEffort: 'high', acpMaxLiveProcesses: '3' };
  expect(await prepareNativeMember(form, cat)).toBe(form);
  expect(apiFetch).not.toHaveBeenCalled();
});

it('does not prepare a Desktop route for effort or pool edits and retains its HOME for a model edit', async () => {
  const cat = {
    id: 'desktop-whale',
    displayName: 'Desktop Whale',
    carrier: 'acp' as const,
    avatar: '',
    roleDescription: '',
    personality: '',
    color: { primary: '#123456', secondary: '#abcdef' },
    mentionPatterns: [],
    clientId: 'acp',
    configurationSource: 'native_tool' as const,
    acp: {
      command: '/install/resources/runtime/cli/bin/dsh.cmd',
      startupArgs: ['--profile', 'acp', '--patch', '/private/member.yml'],
    },
    defaultModel: '["official","flash"]',
    env: { DSH_HOME: '/private/home' },
  };
  const form = initialState(cat);
  expect(
    needsDshPreparation(
      { ...form, cliEffort: 'high', acpMaxLiveProcesses: '3', acpIdleTtlMinutes: '8', cliConfigArgs: ['--verbose'] },
      cat,
    ),
  ).toBe(false);
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    if (url.endsWith('/agent-access/v1/detect'))
      return Response.json({
        readiness: { state: 'ready' },
        candidates: [{ ...runtime, acp: { ...runtime.acp, command: cat.acp.command } }],
      });
    if (url.endsWith('/inspect'))
      return Response.json({
        revision: 'revision',
        provider: 'custom',
        model: 'selected',
        providers: [{ id: 'custom', credential: 'configured', models: [{ id: 'selected' }] }],
      });
    return Response.json({
      command: cat.acp.command,
      startupArgs: ['--profile', 'acp', '--patch', '/private/new.yml'],
      env: cat.env,
      provider: 'custom',
      model: 'selected',
    });
  });
  const prepared = await prepareNativeMember({ ...form, defaultModel: '["custom","selected"]' }, cat);
  expect(prepared.env?.DSH_HOME).toBe(cat.env.DSH_HOME);
  expect(
    JSON.parse(String(vi.mocked(apiFetch).mock.calls.find(([url]) => url.endsWith('/prepare'))?.[1]?.body)),
  ).toMatchObject({ memberId: cat.id });
});
