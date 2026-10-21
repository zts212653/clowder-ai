import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { writeShellLanguage } from '../../shell/shell-language';
import { MemberCopyContext } from '../editor-presentation';
import { MemberStatus } from '../MemberStatus';
import { membersCopy } from '../members.shell-copy';

vi.mock('../../settings/OpenTeamWorkspaceButton', () => ({
  OpenTeamWorkspaceButton: ({ label }: { label: string }) => <button type="button">{label}</button>,
}));
let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  writeShellLanguage('en');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  writeShellLanguage('zh');
  vi.unstubAllGlobals();
});
it('shows one availability word, then exposes evidence and the records action on keyboard focus', async () => {
  await act(async () =>
    root.render(
      <MemberCopyContext.Provider value={membersCopy.en}>
        <MemberStatus
          catId="sol"
          status={{ label: '已恢复', detail: '最近一次接活顺利完成', observedAt: 1000, tone: 'ok' }}
        />
      </MemberCopyContext.Provider>,
    ),
  );
  expect(host.textContent).toBe('Available');
  expect(host.querySelector('small')).toBeNull();
  expect(host.querySelector('time')).toBeNull();
  const trigger = host.querySelector<HTMLElement>('button');
  expect(trigger).toBeTruthy();
  await act(async () => trigger?.focus());
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
    'The latest work dispatch finished successfully',
  );
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('View work records');
});

it.each([
  'zh',
  'en',
] as const)('explains missing work history in %s instead of showing a bare link', async (language) => {
  writeShellLanguage(language);
  await act(async () =>
    root.render(
      <MemberCopyContext.Provider value={membersCopy[language]}>
        <MemberStatus catId="sol" status={{ label: '可用', detail: '', tone: 'ok' }} />
      </MemberCopyContext.Provider>,
    ),
  );
  await act(async () => host.querySelector<HTMLElement>('button')?.focus());
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
    language === 'zh' ? '还没有接活记录' : 'No work records yet',
  );
});
