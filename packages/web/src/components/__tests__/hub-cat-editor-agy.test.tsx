import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { buildCatPatchPayload, initialState } from '../hub-cat-editor.model';
import { AccountSection } from '../hub-cat-editor.sections';
import { AgyNativeFields } from '../hub-cat-editor-agy';

const cat: CatData = {
  id: 'gemini38',
  displayName: '烁烁',
  carrier: 'cli',
  clientId: 'google',
  accountRef: 'gemini',
  defaultModel: 'Gemini 3.8 Flash (High)',
  color: { primary: '#123456', secondary: '#abcdef' },
  mentionPatterns: ['@gemini38'],
  avatar: '/avatars/default.png',
  roleDescription: 'test',
  personality: '',
};
const profile = {
  enabled: true,
  carrier: 'native' as const,
  profileId: 'gemini38',
  homeRoot: '/isolated/profiles',
  model: 'gemini-3.8-flash-high',
  autoApprove: false,
  trustedWorkspaces: ['/approved/workspace'],
};
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let unmount: (() => void) | undefined;
afterEach(() => {
  unmount?.();
  unmount = undefined;
});

describe('AGY Native member settings', () => {
  it('offers official ACP and round trips its isolated personal profile without CLI startup arguments', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onChange = vi.fn();
    unmount = () => {
      act(() => root.unmount());
      container.remove();
    };
    await act(async () =>
      root.render(
        <AccountSection
          form={initialState(cat)}
          modelOptions={[]}
          availableProfiles={[]}
          loadingProfiles={false}
          onChange={onChange}
        />,
      ),
    );
    const transport = container.querySelector<HTMLSelectElement>('select[aria-label="接入方式"]');
    expect(container.querySelector('option[value="agy-acp"]')).not.toBeNull();
    await act(async () => {
      if (!transport) throw new Error('Transport missing');
      transport.value = 'agy-acp';
      transport.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        carrier: 'acp',
        agyAcpEnabled: true,
        agyNativeEnabled: false,
        acpCommand: 'agy_acp_server.par',
        acpStartupArgs: '',
      }),
    );
    const acpProfile = { ...profile, carrier: 'acp' as const };
    const member = {
      ...cat,
      carrier: 'acp' as const,
      agyProfile: acpProfile,
      acp: { command: '/installed/agy_acp_server.par', startupArgs: [] },
    };
    const form = initialState(member);
    expect(form.agyAcpEnabled).toBe(true);
    await act(async () =>
      root.render(
        <AccountSection
          form={form}
          modelOptions={[]}
          availableProfiles={[]}
          loadingProfiles={false}
          onChange={onChange}
        />,
      ),
    );
    expect(container.querySelector('select[aria-label="插件 ACP client"]')).toBeNull();
    expect(container.querySelector('input[aria-label="ACP Command"]')).not.toBeNull();
    const payload = buildCatPatchPayload(form, member, { accountAuthType: 'oauth' });
    expect(payload.agyProfile).toEqual(acpProfile);
    expect(payload.acp).toEqual(member.acp);
    expect(payload.carrier).toBe('acp');
  });
  it('offers Native for Gemini and binds profile fields to the transport choice', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    unmount = () => {
      act(() => root.unmount());
      container.remove();
    };
    const onChange = vi.fn();
    await act(async () =>
      root.render(
        <AccountSection
          form={initialState(cat)}
          modelOptions={[]}
          availableProfiles={[]}
          loadingProfiles={false}
          onChange={onChange}
        />,
      ),
    );
    const transport = container.querySelector<HTMLSelectElement>('select[aria-label="接入方式"]');
    expect(Array.from(transport?.options ?? []).map((option) => option.value)).toContain('agy-native');
    expect(Array.from(transport?.options ?? []).map((option) => option.value)).not.toContain('cli');
    expect(Array.from(transport?.options ?? []).map((option) => option.value)).not.toContain('acp');
    await act(async () => {
      if (!transport) throw new Error('Transport missing');
      transport.value = 'agy-native';
      transport.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ agyNativeEnabled: true, carrier: 'cli' }));
    await act(async () =>
      root.render(
        <AccountSection
          form={{ ...initialState(cat), agyNativeEnabled: true }}
          modelOptions={[]}
          availableProfiles={[]}
          loadingProfiles={false}
          onChange={onChange}
        />,
      ),
    );
    expect(container.textContent).toContain('隔离 Profile');
    expect(container.textContent).toContain('批准工作区');
    await act(async () =>
      root.render(
        <AccountSection
          form={initialState({ ...cat, clientId: 'kimi' })}
          modelOptions={[]}
          availableProfiles={[]}
          loadingProfiles={false}
          onChange={onChange}
        />,
      ),
    );
    expect(container.querySelector('option[value="agy-native"]')).toBeNull();
  });

  it('lets the member select automatic approval and removes the restricted workspace field', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    unmount = () => {
      act(() => root.unmount());
      container.remove();
    };
    const onChange = vi.fn();
    const form = initialState({ ...cat, agyProfile: profile });
    await act(async () => root.render(<AgyNativeFields form={form} onChange={onChange} />));
    expect(container.textContent).toContain('直接拒绝');
    const select = [...container.querySelectorAll('select')].find((element) =>
      element.querySelector('option[value="auto"]'),
    );
    expect(select).toBeTruthy();
    await act(async () => {
      if (!select) throw new Error('Permission choice missing');
      select.value = 'auto';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith({ agyAutoApprove: true });
    await act(async () =>
      root.render(<AgyNativeFields form={{ ...form, agyAutoApprove: true }} onChange={onChange} />),
    );
    expect(container.textContent).not.toContain('批准工作区');
    expect(container.textContent).not.toContain('直接拒绝');
    expect(container.textContent).toContain('自动批准文件与命令操作');
    expect(container.querySelector('textarea')).toBeNull();
  });

  it('does not inherit legacy CLI automatic approval when selecting a new Native carrier', () => {
    const legacy = { ...cat, agyProfile: { ...profile, carrier: 'legacy' as const, autoApprove: true } };
    expect(initialState(legacy).agyAutoApprove).toBe(false);
  });

  it('preserves explicit automatic approval without requiring a workspace allowlist', () => {
    const automatic = { ...profile, autoApprove: true, trustedWorkspaces: [] };
    const nativeCat = { ...cat, agyProfile: automatic };
    const form = initialState(nativeCat);
    expect(form.agyAutoApprove).toBe(true);
    expect(buildCatPatchPayload(form, nativeCat, { accountAuthType: 'oauth' }).agyProfile).toEqual(automatic);
    expect(() => buildCatPatchPayload({ ...form, agyAutoApprove: false }, nativeCat)).toThrow(/工作区/);
  });

  it('round trips Native configuration and uses the physical model ID', () => {
    const nativeCat = { ...cat, agyProfile: profile };
    const form = initialState(nativeCat);
    expect(form.agyNativeEnabled).toBe(true);
    expect(form.defaultModel).toBe(profile.model);
    expect(form.agyTrustedWorkspaces).toBe('/approved/workspace');
    const payload = buildCatPatchPayload(form, nativeCat, { accountAuthType: 'oauth' });
    expect(payload.agyProfile).toEqual(profile);
    expect(payload.defaultModel).toBe(profile.model);
  });

  it('clears Native on CLI / ACP / client changes, without leaking a coding grant', () => {
    const nativeCat = { ...cat, agyProfile: profile };
    for (const patch of [{ agyNativeEnabled: false }, { carrier: 'acp' as const }, { clientId: 'openai' as const }]) {
      const payload = buildCatPatchPayload({ ...initialState(nativeCat), ...patch }, nativeCat);
      expect(payload.agyProfile).toBeNull();
    }
    const legacy = {
      ...initialState(cat),
      agyNativeEnabled: true,
      agyProfileId: 'gemini38',
      defaultModel: profile.model,
      agyHomeRoot: '',
      agyTrustedWorkspaces: '/approved/workspace',
      cliConfigArgs: ['--unsafe-option'],
    };
    const payload = buildCatPatchPayload(
      legacy,
      { ...cat, cliConfigArgs: ['--unsafe-option'] },
      { accountAuthType: 'oauth' },
    );
    expect(payload.cliConfigArgs).toEqual([]);
    expect(payload.agyProfile).not.toHaveProperty('nativeCodingGrant');
    expect(() => buildCatPatchPayload({ ...legacy, agyTrustedWorkspaces: '' }, cat)).toThrow(/工作区/);
    expect(() => buildCatPatchPayload({ ...legacy, agyTrustedWorkspaces: 'relative/path' }, cat)).toThrow(/绝对路径/);
    expect(() => buildCatPatchPayload({ ...legacy, defaultModel: cat.defaultModel }, cat)).toThrow(/模型/);
    expect(() => buildCatPatchPayload(legacy, cat, { accountAuthType: 'api_key' })).toThrow(/OAuth/);
  });
});
