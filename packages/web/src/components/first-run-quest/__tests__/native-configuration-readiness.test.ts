import { describe, expect, it } from 'vitest';
import { type RuntimeChoice, runtimeDefaults } from '../../settings/members/member-runtime-draft';
import { nativeRuntimeSelectable } from '../native-onboarding';

describe('native configuration readiness', () => {
  it('does not recommend AGY when its required native model has not been discovered', () => {
    const runtime: RuntimeChoice = {
      id: 'agy-native',
      label: 'AGY Native',
      clientId: 'google',
      agyCarrier: 'native',
      installed: true,
      models: [],
    };
    expect(nativeRuntimeSelectable(runtime)).toBe(false);
  });
  it('retains the discovered AGY model required by the isolated native carrier', () => {
    const runtime: RuntimeChoice = {
      id: 'agy-native',
      label: 'AGY Native',
      clientId: 'google',
      agyCarrier: 'native',
      installed: true,
      configuredModel: 'native-model',
      models: ['native-model'],
    };
    expect(runtimeDefaults(runtime).defaultModel).toBe('native-model');
  });
  it('does not apply default credential evidence to an explicitly selected different DSH model', () => {
    const runtime: RuntimeChoice = {
      id: 'dsh',
      label: 'DSH',
      clientId: 'acp',
      installed: true,
      models: [],
      acp: { command: 'dsh', startupArgs: ['--profile', 'acp'] },
      readiness: { status: 'configuration_required', checkedAt: 0 },
    };
    expect(nativeRuntimeSelectable(runtime)).toBe(false);
    expect(
      nativeRuntimeSelectable(runtime, {
        ...runtimeDefaults(runtime),
        defaultModel: '["working-provider","working-model"]',
      } as never),
    ).toBe(true);
  });
  it.each(['openai', 'anthropic'] as const)('keeps %s login requirements when only the model changes', (clientId) => {
    const runtime: RuntimeChoice = {
      id: clientId,
      label: clientId,
      clientId,
      installed: true,
      models: [],
      readiness: { status: 'login_required', checkedAt: 0 },
    };
    expect(
      nativeRuntimeSelectable(runtime, { ...runtimeDefaults(runtime), defaultModel: 'another-model' } as never),
    ).toBe(false);
  });
});
