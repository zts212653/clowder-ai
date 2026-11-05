import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { memberModelCatalogKey, useMemberModelCatalogs } from '@/lib/member-model-display';
import { writeShellLanguage } from '../../shell/shell-language';
import { MemberCopyProvider } from '../editor-presentation';
import { MemberRuntimeSummary } from '../MemberRuntimeSummary';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
afterEach(() => {
  writeShellLanguage('zh');
  useMemberModelCatalogs.setState({ catalogs: {} });
});
it.each([
  'zh',
  'en',
] as const)('shows %s native inheritance without claiming missing configuration or successful login', (language) => {
  writeShellLanguage(language);
  const host = document.createElement('div');
  const root = createRoot(host);
  const native = { clientId: 'openai', configurationSource: 'native_tool', defaultModel: '' } as CatData;
  act(() =>
    root.render(
      <MemberCopyProvider>
        <MemberRuntimeSummary cat={native} />
      </MemberCopyProvider>,
    ),
  );
  expect(host.textContent).toBe(language === 'zh' ? 'Codex · 跟随工具设置' : 'Codex · Follow tool settings');
  act(() =>
    root.render(
      <MemberCopyProvider>
        <MemberRuntimeSummary cat={{ ...native, defaultModel: 'selected-model' }} />
      </MemberCopyProvider>,
    ),
  );
  expect(host.textContent).toBe('Codex · selected-model');
  act(() =>
    root.render(
      <MemberCopyProvider>
        <MemberRuntimeSummary cat={{ ...native, clientId: 'acp', acp: { command: 'dsh', startupArgs: [] } }} />
      </MemberCopyProvider>,
    ),
  );
  expect(host.textContent).toContain('DSH · ');
  act(() =>
    root.render(
      <MemberCopyProvider>
        <MemberRuntimeSummary cat={{ ...native, configurationSource: undefined }} />
      </MemberCopyProvider>,
    ),
  );
  expect(host.textContent).toBe(language === 'zh' ? 'Codex · 未设置' : 'Codex · Not set');
  act(() => root.unmount());
});

it('shares reported names across views without applying a catalog to a different model or connection', () => {
  const cat = {
    id: 'dsh',
    clientId: 'acp',
    configurationSource: 'native_tool',
    defaultModel: '["provider","first"]',
    acp: { command: 'dsh', startupArgs: ['--profile', 'acp'] },
  } as CatData;
  const host = document.createElement('div');
  const root = createRoot(host);
  act(() => root.render(<MemberRuntimeSummary cat={cat} />));
  expect(host.textContent).toContain('provider / first · 模型 ID');
  act(() =>
    useMemberModelCatalogs.setState({
      catalogs: {
        [memberModelCatalogKey(cat)]: {
          status: 'live',
          defaultModel: cat.defaultModel,
          models: [{ value: cat.defaultModel, label: 'Reported First' }],
        },
      },
    }),
  );
  expect(host.textContent).toBe('DSH · Reported First');
  act(() => root.render(<MemberRuntimeSummary cat={{ ...cat, defaultModel: '' }} />));
  expect(host.textContent).toBe('DSH · Reported First · 跟随工具设置');
  act(() => root.render(<MemberRuntimeSummary cat={{ ...cat, accountRef: 'other' }} />));
  expect(host.textContent).toContain('provider / first · 模型 ID');
  act(() => root.render(<MemberRuntimeSummary cat={{ ...cat, defaultModel: '["provider","second"]' }} />));
  expect(host.textContent).toContain('provider / second · 模型 ID');
  expect(host.textContent).not.toContain('Reported First');
  act(() => root.unmount());
});

it('shows the saved DSH route as a model ID without renaming another ACP tool', () => {
  const host = document.createElement('div');
  const root = createRoot(host);
  const cat = {
    clientId: 'acp',
    configurationSource: 'native_tool',
    defaultModel: '["gateway","model"]',
    acp: { command: 'dsh.cmd', startupArgs: ['--profile', 'acp'] },
  } as CatData;
  act(() => root.render(<MemberRuntimeSummary cat={cat} />));
  expect(host.textContent).toContain('DSH · gateway / model · 模型 ID');
  act(() =>
    root.render(
      <MemberRuntimeSummary
        cat={{ ...cat, acp: { command: 'custom-acp', startupArgs: ['--provider', 'deepseek'] } }}
      />,
    ),
  );
  expect(host.textContent).toContain('["gateway","model"]');
  expect(host.textContent).not.toContain('DSH');
  act(() => root.unmount());
});

it.each([
  { agentProvider: 'plugin:official.codeagent/codeagent', nested: undefined, dsh: false },
  { agentProvider: undefined, nested: 'plugin:official.codeagent/codeagent', dsh: false },
  { agentProvider: null, nested: 'plugin:official.codeagent/codeagent', dsh: true },
  { agentProvider: undefined, nested: undefined, dsh: true },
])('respects effective plugin binding over retained DSH fields: %j', ({ agentProvider, nested, dsh }) => {
  const cat = {
    id: 'binding',
    clientId: 'acp',
    configurationSource: 'native_tool',
    defaultModel: '["plugin-provider","plugin-model"]',
    agentProvider,
    acp: { command: 'dsh', startupArgs: ['--profile', 'acp'], agentProvider: nested },
  } as CatData;
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    act(() => root.render(<MemberRuntimeSummary cat={cat} />));
    expect(host.textContent).toContain(dsh ? 'DSH · plugin-provider / plugin-model · 模型 ID' : cat.defaultModel);
    if (!dsh) expect(host.textContent).not.toContain('DSH');
  } finally {
    act(() => root.unmount());
  }
});
