import { expect, it } from 'vitest';
import { initialState } from '../../hub-cat-editor.model';
import { dshConnectionKey, runtimeDefaults } from '../../settings/members/member-runtime-draft';
import { nativeRuntimeSelectable, recommendNativePartners } from '../native-onboarding';

it('DSH one-click creation prepares automatically without a model-request gate', () => {
  const runtime = {
    id: 'dsh',
    label: 'DSH Desktop',
    clientId: 'acp' as const,
    installed: true,
    dshDesktop: true,
    models: [],
    acp: { command: 'dsh', startupArgs: ['--profile', 'acp'], transport: 'stdio' as const },
  };
  const form = { ...initialState(), ...runtimeDefaults(runtime) };
  expect(nativeRuntimeSelectable(runtime, form)).toBe(true);
  const verified = {
    ...runtime,
    connectionVerification: {
      key: dshConnectionKey(form),
      checkedAt: Date.now(),
    },
  };
  expect(nativeRuntimeSelectable(verified, form)).toBe(true);
  expect(nativeRuntimeSelectable(verified, { ...form, defaultModel: '["custom","another-model"]' })).toBe(true);
  expect(nativeRuntimeSelectable(verified, { ...form, cliEffort: 'high' })).toBe(true);
  expect(nativeRuntimeSelectable(verified, { ...form, env: { DSH_HOME: '/different/home' } })).toBe(true);
});

it('does not recommend saved manual DSH entries as new automatic Desktop members', () => {
  const manual = {
    id: 'acp:legacy',
    label: 'DSH',
    clientId: 'acp' as const,
    installed: true,
    models: [],
    onboardingEligible: false,
    acp: { command: 'dsh', startupArgs: ['--profile', 'acp'] },
  };
  expect(recommendNativePartners([manual], [], [], 'journey')).toEqual([]);
});
