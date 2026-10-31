import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useF307ExperienceWorkbenchStore } from '../experience-workbench-store';
import { F307FileOwnerSurface } from '../F307FileOwnerSurface';
import { createFilePreviewSurface } from '../real-surface-adapters';
import { createInitialWorkbenchState } from '../workbench-model';

const mocks = vi.hoisted(() => ({ presentation: 'v2', toggle: vi.fn() }));
vi.mock('@/components/shell/shell-presentation', () => ({ useShellPresentation: () => mocks.presentation }));
vi.mock('@/utils/api-client', () => ({
  apiFetch: async () =>
    new Response(
      JSON.stringify({
        path: 'note.ts',
        content: 'export const note = 1;',
        sha256: 'file-sha',
        mime: 'text/plain',
        truncated: false,
      }),
    ),
}));
vi.mock('@/hooks/useFileEditing', () => ({
  useFileEditing: () => ({ canEdit: true, editMode: false, setEditMode: vi.fn(), handleToggleEdit: mocks.toggle }),
}));
vi.mock('@/hooks/useWorkspaceFileChange', () => ({ useWorkspaceFileChange: () => ({}) }));
vi.mock('../useWorkspaceFileViewport', () => ({ useWorkspaceFileViewport: () => ({}) }));
vi.mock('@/components/workspace/WorkspaceFileViewer', () => ({
  WorkspaceFileViewer: ({
    onOpenCollaboration,
    onToggleEdit,
  }: {
    onOpenCollaboration: () => void;
    onToggleEdit: () => void;
  }) => (
    <div data-testid="ordinary-file-owner">
      <button type="button" onClick={onOpenCollaboration}>
        批注
      </button>
      <button type="button" onClick={onToggleEdit}>
        编辑
      </button>
    </div>
  ),
}));
vi.mock('../content-review/WorkspaceContentReviewSurface', () => ({
  WorkspaceContentReviewSurface: () => <div data-testid="ordinary-review-owner" />,
}));

const file = createFilePreviewSurface({ worktreeId: 'preview-intent-root', path: 'note.ts' });
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.presentation = 'v2';
  mocks.toggle.mockReset();
  localStorage.clear();
  useF307ExperienceWorkbenchStore.setState({
    layout: { ...createInitialWorkbenchState([file]), previewSurfaceId: file.id },
    hydrated: true,
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  localStorage.clear();
});
async function render() {
  await act(async () => {
    root.render(<F307FileOwnerSurface surface={file} onRequestDetach={vi.fn()} />);
    await Promise.resolve();
    await Promise.resolve();
  });
}
function click(label: string) {
  const button = [...container.querySelectorAll('button')].find((node) => node.textContent === label);
  if (!button) throw new Error(`The original file action is missing: ${label}`);
  act(() => button.click());
}
it('keeps an ordinary file read in the declared preview slot', async () => {
  await render();
  expect(container.querySelector('[data-testid="ordinary-file-owner"]')).not.toBeNull();
  expect(useF307ExperienceWorkbenchStore.getState().layout.previewSurfaceId).toBe(file.id);
});
it('promotes the same file before opening its original annotation owner', async () => {
  await render();
  click('批注');
  expect(container.querySelector('[data-testid="ordinary-review-owner"]')).not.toBeNull();
  const layout = useF307ExperienceWorkbenchStore.getState().layout;
  expect(layout.previewSurfaceId).toBeNull();
  expect(layout.surfaces).toEqual([file]);
  expect(layout.surfaces[0]).toBe(file);
});
it('promotes before the existing file edit callback without replacing the descriptor', async () => {
  mocks.toggle.mockImplementation(() =>
    expect(useF307ExperienceWorkbenchStore.getState().layout.previewSurfaceId).toBeNull(),
  );
  await render();
  click('编辑');
  expect(mocks.toggle).toHaveBeenCalledOnce();
  expect(useF307ExperienceWorkbenchStore.getState().layout.surfaces[0]).toBe(file);
});
it('does not promote a classic collaboration view simply by mounting it', async () => {
  mocks.presentation = 'classic';
  await render();
  expect(container.querySelector('[data-testid="ordinary-review-owner"]')).not.toBeNull();
  expect(useF307ExperienceWorkbenchStore.getState().layout.previewSurfaceId).toBe(file.id);
});
