import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { canonicalLauncherDestination } from '@/components/workspace/WorkspaceLauncher';
import { resolveFilesTarget } from '../real-surface-adapters';
import type { WorkspaceDestinationAdmission } from '../use-workspace-destination-admission';
import { useWorkspaceDestinationAdmission } from '../use-workspace-destination-admission';

let root: Root;
let container: HTMLDivElement;
let admission: WorkspaceDestinationAdmission;
const opened = vi.fn();
function Harness({
  threadId,
  worktreeId,
  loading = true,
}: {
  threadId?: string;
  worktreeId: string | null;
  loading?: boolean;
}) {
  admission = useWorkspaceDestinationAdmission({
    context: { threadId, worktreeId, openFilePath: null, preview: { path: '/' } },
    worktreeLoading: loading,
    worktreeError: null,
    onSelectSurface: opened,
  });
  return <output>{admission.message}</output>;
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  opened.mockClear();
  localStorage.clear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  localStorage.clear();
});
async function render(threadId: string | undefined, worktreeId: string | null, loading = true) {
  await act(async () => root.render(<Harness threadId={threadId} worktreeId={worktreeId} loading={loading} />));
}

it('admits the global Home without inventing a thread or a notice', async () => {
  await render(undefined, 'work-global', false);
  expect(admission.message).toBeNull();
  await act(async () => admission.onSelectDestination(canonicalLauncherDestination('surface', 'files')));
  expect(opened).toHaveBeenCalledTimes(1);
});

it('admits one explicit Files selection after its same-thread worktree becomes available', async () => {
  await render('A', null);
  await act(async () => admission.onSelectDestination(canonicalLauncherDestination('surface', 'files')));
  expect(opened).not.toHaveBeenCalled();
  expect(container.textContent).toContain('正在读取工作区');
  await render('A', 'work-a', false);
  expect(opened).toHaveBeenCalledTimes(1);
  expect(resolveFilesTarget(opened.mock.calls[0][0])?.worktreeId).toBe('work-a');
  await render('A', 'work-a', false);
  expect(opened).toHaveBeenCalledTimes(1);
});

it('never applies a pending click to a newly selected thread or replays it on a later revisit', async () => {
  await render('A', null);
  await act(async () => admission.onSelectDestination(canonicalLauncherDestination('surface', 'files')));
  await render('B', 'work-b', false);
  expect(opened).not.toHaveBeenCalled();
  expect(container.textContent).toBe('');
  await render('A', 'work-a', false);
  expect(opened).not.toHaveBeenCalled();
});

it('keeps unavailable ownership visible and allows a new genuine retry', async () => {
  await render('A', null, false);
  await act(async () => admission.onSelectDestination(canonicalLauncherDestination('surface', 'files')));
  expect(container.textContent).toContain('没有可用工作区');
  expect(opened).not.toHaveBeenCalled();
  await render('A', 'work-a', false);
  expect(opened).not.toHaveBeenCalled();
  await act(async () => admission.onSelectDestination(canonicalLauncherDestination('surface', 'files')));
  expect(opened).toHaveBeenCalledTimes(1);
  expect(container.textContent).toBe('');
});

it('voice surface title and context follow the shell language (audit row 44)', async () => {
  const { writeShellLanguage } = await import('@/components/shell/shell-language');
  const { writeShellPresentation } = await import('@/components/shell/shell-presentation');
  writeShellPresentation('v2');
  writeShellLanguage('en');
  await render('A', 'work-a', false);
  await act(async () => admission.onSelectDestination(canonicalLauncherDestination('host', 'voice')));
  expect(opened).toHaveBeenCalledTimes(1);
  const enSurface = opened.mock.calls[0][0] as { title: string; context?: string };
  expect(enSurface.title).toBe('Voice & meetings');
  expect(enSurface.context).toBe('Voice transcription and meeting notes');
  await act(async () => {
    writeShellLanguage('zh');
  });
  await act(async () => admission.onSelectDestination(canonicalLauncherDestination('host', 'voice')));
  expect(opened).toHaveBeenCalledTimes(2);
  const zhSurface = opened.mock.calls[1][0] as { title: string; context?: string };
  expect(zhSurface.title).toBe('语音与会议');
  expect(zhSurface.context).toBe('语音转写、会议记录');
});
