import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { writeShellLanguage } from '../../shell/shell-language';
import { MemberCopyProvider } from '../editor-presentation';
import { MemberRuntimeSummary } from '../MemberRuntimeSummary';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
afterEach(() => writeShellLanguage('zh'));
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
