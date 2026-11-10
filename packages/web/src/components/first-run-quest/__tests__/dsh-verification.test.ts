import { expect, it } from 'vitest';
import { initialState } from '../../hub-cat-editor.model';
import { runtimeDefaults } from '../../settings/members/member-runtime-draft';
import { nativeRuntimeSelectable } from '../native-onboarding';

it('DSH one-click creation requires a real check for the same launch and model', () => {
  const runtime = {
    id: 'dsh',
    label: 'DSH Desktop',
    clientId: 'acp' as const,
    installed: true,
    models: [],
    acp: { command: 'dsh', startupArgs: ['--profile', 'acp'], transport: 'stdio' as const },
  };
  const form = { ...initialState(), ...runtimeDefaults(runtime) };
  expect(nativeRuntimeSelectable(runtime, form)).toBe(false);
  const verified = {
    ...runtime,
    connectionVerification: {
      key: JSON.stringify(['dsh', ['--profile', 'acp'], 'stdio', '', '']),
      checkedAt: Date.now(),
    },
  };
  expect(nativeRuntimeSelectable(verified, form)).toBe(true);
  expect(nativeRuntimeSelectable(verified, { ...form, defaultModel: '["custom","another-model"]' })).toBe(false);
  expect(nativeRuntimeSelectable(verified, { ...form, cliEffort: 'high' })).toBe(false);
  expect(nativeRuntimeSelectable(verified, { ...form, acpCommand: 'another-dsh' })).toBe(false);
  expect(nativeRuntimeSelectable(verified, { ...form, commandArgs: '--custom-startup' })).toBe(false);
  expect(nativeRuntimeSelectable(verified, { ...form, accountRef: 'another-identity' })).toBe(false);
});
