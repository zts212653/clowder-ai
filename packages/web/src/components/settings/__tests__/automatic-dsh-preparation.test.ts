import { beforeEach, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { initialState } from '../../hub-cat-editor.model';
import { prepareNativeMember } from '../members/prepare-native-member';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
const runtime = {
  id: 'dsh',
  dshDesktop: true,
  installed: true,
  acp: { command: '/desktop/dsh.cmd', startupArgs: ['--profile', 'acp'] },
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    if (url.endsWith('/native-runtimes')) return Response.json({ runtimes: [runtime] });
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
