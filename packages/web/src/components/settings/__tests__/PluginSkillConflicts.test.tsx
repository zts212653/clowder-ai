import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { PluginDetailHeader } from '../plugin-manager/controls/PluginManagerDetailChrome';
import { PluginSkillConflicts } from '../plugin-manager/PluginSkillConflicts';
import { PLUGIN_MANAGER_DESIGN_FIXTURES } from '../plugin-manager/plugin-manager-fixtures';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('@/components/useConfirm', () => ({
  useOptionalConfirm: () => async () => window.confirm('Choose skill source'),
}));
const conflict = {
  skillName: 'guide',
  mountPointId: 'codex',
  path: '.codex/skills/guide',
  source: 'Local file or directory',
  canResolve: true,
  revision: 'a'.repeat(64),
};
const plugin = {
  ...PLUGIN_MANAGER_DESIGN_FIXTURES[0],
  id: 'fixture.skills',
  lifecycleRevision: 4,
  skillConflicts: [conflict],
  actions: { install: false, restart: true, setEnabled: true, uninstall: true, blockingReasons: [] },
};
let container: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.mocked(apiFetch).mockReset();
});

it('exposes restart and uninstall beside the plugin identity for a running plugin', () => {
  const restart = vi.fn(),
    uninstall = vi.fn();
  act(() =>
    root.render(
      <PluginDetailHeader plugin={plugin} locale="zh-CN" busy={false} onRestart={restart} onUninstall={uninstall} />,
    ),
  );
  const header = container.querySelector('header')!;
  expect(header.textContent).toContain('重启插件');
  expect(header.textContent).not.toContain('修复');
  act(() => {
    header.querySelector<HTMLButtonElement>('[data-plugin-detail-action="restart"]')!.click();
    header.querySelector<HTMLButtonElement>('[data-plugin-uninstall]')!.click();
  });
  expect(restart).toHaveBeenCalledOnce();
  expect(uninstall).toHaveBeenCalledOnce();
});

it('explains the conflict and only changes the selected source after confirmation', async () => {
  const refresh = vi.fn();
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  vi.mocked(apiFetch).mockResolvedValue(
    new Response(JSON.stringify({ backupPath: '.codex/skills/.guide.backup-preserved' }), { status: 200 }),
  );
  act(() => root.render(<PluginSkillConflicts plugin={plugin} locale="zh-CN" onResolved={refresh} />));
  expect(container.textContent).toContain('技能冲突');
  expect(container.textContent).toContain('插件其他能力可继续运行');
  expect(container.textContent).toContain('.codex/skills/guide');
  await act(async () => container.querySelector('button')!.click());
  expect(apiFetch).not.toHaveBeenCalled();
  confirm.mockReturnValue(true);
  await act(async () => container.querySelector('button')!.click());
  expect(apiFetch).toHaveBeenCalledWith(
    '/api/plugin-manager/plugins/fixture.skills/skills/resolve',
    expect.objectContaining({ method: 'POST' }),
  );
  const request = JSON.parse(vi.mocked(apiFetch).mock.calls[0][1]!.body as string);
  expect(request).toEqual({
    skillName: 'guide',
    mountPointId: 'codex',
    revision: conflict.revision,
    expectedRevision: 4,
    confirmed: true,
  });
  expect(refresh).toHaveBeenCalledOnce();
  expect(container.querySelector('[role="status"]')?.textContent).toContain('.guide.backup-preserved');
});

it('shows a stale-choice failure instead of retrying or claiming resolution', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.mocked(apiFetch).mockResolvedValue(
    new Response(JSON.stringify({ error: 'Conflict changed; refresh', code: 'STALE_REVISION' }), { status: 409 }),
  );
  act(() => root.render(<PluginSkillConflicts plugin={plugin} locale="zh-CN" />));
  await act(async () => container.querySelector('button')!.click());
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Conflict changed; refresh');
  expect(container.querySelector('[role="status"]')).toBeNull();
  expect(apiFetch).toHaveBeenCalledOnce();
});
