import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { type HubCatEditorFormState, initialState } from '../../hub-cat-editor.model';
import type { RuntimeChoice } from '../../settings/members/member-runtime-draft';
import { runtimeDefaults } from '../../settings/members/member-runtime-draft';
import { NativePartnerCard } from '../NativePartnerCard';
import type { NativePartner } from '../native-onboarding';

vi.mock('../../settings/members/MemberRuntimeFields', () => ({ MemberRuntimeFields: () => null }));
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
function mount(
  status: 'configured' | 'login_required' | 'unknown',
  change: Partial<HubCatEditorFormState> = {},
  clientId: 'anthropic' | 'openai' | 'opencode' | 'kimi' | 'acp' = 'anthropic',
  runtimeChange: Partial<RuntimeChoice> = {},
) {
  const runtime: RuntimeChoice = {
    id: clientId === 'openai' ? 'codex' : clientId === 'anthropic' ? 'claude' : clientId,
    label:
      clientId === 'openai'
        ? 'Codex'
        : clientId === 'opencode'
          ? 'OpenCode'
          : clientId === 'kimi'
            ? 'Kimi'
            : 'Claude Code',
    clientId,
    installed: true,
    models: [],
    readiness: {
      status,
      checkedAt: 1,
      loginCommand:
        clientId === 'kimi'
          ? 'fixture-instance-kimi login'
          : clientId === 'openai'
            ? 'codex login'
            : 'claude auth login',
    },
    ...runtimeChange,
  };
  const partner: NativePartner = {
    id: runtime.id,
    runtime,
    selected: true,
    form: { ...initialState(), ...runtimeDefaults(runtime), ...change },
  };
  act(() => root.render(<NativePartnerCard partner={partner} created patch={vi.fn()} onValidityChange={vi.fn()} />));
  return host.textContent ?? '';
}
it.each(['configured', 'login_required'] as const)('retains %s evidence for the ordinary default partner', (status) => {
  expect(mount(status)).toContain(status === 'configured' ? '已检测登录' : '尚未登录');
});
it('does not promise Codex creation before the native login admission check can pass', () => {
  const text = mount('login_required', {}, 'openai');
  expect(text).toContain('新增伙伴前需要先登录');
  expect(text).not.toContain('可先创建伙伴');
});
it('explains that OpenCode can use the default workspace without requiring a selected project', () => {
  expect(mount('configured', {}, 'opencode')).toContain('未选择项目时使用默认工作区');
});
it('shows an installed Kimi without an unverified-login warning or sign-in command', () => {
  const text = mount('unknown', {}, 'kimi');
  expect(text).not.toContain('Kimi 登录状态尚未验证');
  expect(text).not.toContain('fixture-instance-kimi login');
  expect(text).not.toContain('已检测登录');
});
it('shows the detected configured model while keeping the role preference inherited', () => {
  expect(mount('unknown', {}, 'kimi', { configuredModel: 'kimi-code/kimi-for-coding' })).toContain(
    'kimi-code/kimi-for-coding',
  );
});
it('shows an explicit role model instead of projecting the tool default onto it', () => {
  const text = mount('unknown', { defaultModel: 'custom/chosen' }, 'opencode', { configuredModel: 'other/model' });
  expect(text).toContain('custom/chosen');
  expect(text).not.toContain('other/model');
});
it('does not project a default tool model onto an explicit account', () => {
  expect(mount('unknown', { accountRef: 'private' }, 'kimi', { configuredModel: 'native/model' })).not.toContain(
    'native/model',
  );
});
it('does not apply the instance-default Kimi login command to another connection', () => {
  const text = mount('unknown', { accountRef: 'private-kimi' }, 'kimi');
  expect(text).not.toContain('fixture-instance-kimi login');
  expect(text).not.toContain('Kimi 登录状态尚未验证');
  expect(text).toContain('此连接的登录状态尚未检查');
});
it.each([
  ['explicit account', { accountRef: 'company-account' }],
  ['custom configuration', { cliConfigArgs: ['--settings', '/fixture/settings.json'] }],
  ['custom startup', { commandArgs: '--custom-startup' }],
  ['ACP identity', { clientId: 'acp' }],
] satisfies [
  string,
  Partial<HubCatEditorFormState>,
][])('does not apply either default login result to %s', (_, change) => {
  for (const status of ['configured', 'login_required'] as const) {
    const text = mount(status, change);
    expect(text).not.toContain('已检测登录');
    expect(text).not.toContain('尚未登录');
    expect(text).toContain('此连接的登录状态尚未检查');
  }
});

it.each(['Pi', 'DSH'])('shows %s inherited model without claiming login evidence', (label) => {
  const text = mount('unknown', {}, 'acp', {
    id: label.toLowerCase(),
    label,
    configuredModel: label === 'Pi' ? '["test-provider","model-x"]' : 'deepseek-v4',
    acp: { command: 'node', startupArgs: ['bridge.js'] },
  });
  expect(text).toContain(label === 'Pi' ? 'test-provider / model-x' : 'deepseek-v4');
  expect(text).not.toContain('已检测登录');
});
it('does not project the detected ACP model after its launch configuration changes', () => {
  expect(
    mount('unknown', { acpStartupArgs: 'different.js' }, 'acp', {
      id: 'pi',
      label: 'Pi',
      configuredModel: '["test-provider","model-x"]',
      acp: { command: 'node', startupArgs: ['bridge.js'] },
    }),
  ).not.toContain('model-x');
});
it('does not project the detected ACP model onto a separate account', () => {
  expect(
    mount('unknown', { accountRef: 'private' }, 'acp', {
      id: 'pi',
      label: 'Pi',
      configuredModel: '["test-provider","model-x"]',
      acp: { command: 'node', startupArgs: ['bridge.js'] },
    }),
  ).not.toContain('model-x');
});
