// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { writeShellPresentation } from '../../shell/shell-presentation';
import { useF307ExperienceWorkbenchStore } from '../../workbench/experience-workbench-store';
import { ContextualWorkspaceChrome } from '../ContextualWorkspaceChrome';

afterEach(() => {
  localStorage.clear();
  useF307ExperienceWorkbenchStore.setState({ focusSurfaceId: null });
});
it('v2 focus hides the same outer header while retaining the mounted content; classic stays visible', () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  writeShellPresentation('v2');
  act(() =>
    root.render(
      <ContextualWorkspaceChrome mode="workspace" onFold={vi.fn()}>
        <iframe title="原页面" />
      </ContextualWorkspaceChrome>,
    ),
  );
  const frame = host.querySelector('iframe');
  act(() => useF307ExperienceWorkbenchStore.setState({ focusSurfaceId: 'browser:owner' }));
  expect(host.querySelector('header')?.hasAttribute('hidden')).toBe(true);
  expect(host.querySelector('iframe')).toBe(frame);
  act(() => writeShellPresentation('classic'));
  expect(host.querySelector('header')?.hasAttribute('hidden')).toBe(false);
  expect(host.querySelector('iframe')).toBe(frame);
  act(() => root.unmount());
  host.remove();
});
