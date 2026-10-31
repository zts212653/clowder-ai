import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { writeShellPresentation } from '../../shell/shell-presentation';
import { createArtifactWorkPresentationState } from '../artifact-work-presentation';
import { enterArtifactWorkMode, toggleArtifactWorkFullWindow } from '../artifact-work-presentation-actions';
import { useF307ExperienceWorkbenchStore } from '../experience-workbench-store';
import { createFileSurface } from '../real-surface-adapters';
import { useArtifactWorkHostPresentation } from '../useArtifactWorkHostPresentation';
import { createInitialWorkbenchState } from '../workbench-model';

let container: HTMLDivElement, root: Root;
function Host({ requested, mediaId, open = true }: { requested: boolean; mediaId: string | null; open?: boolean }) {
  const state = useArtifactWorkHostPresentation({
    threadId: 'thread-a',
    currentThreadId: 'thread-a',
    viewMode: 'single',
    isDesktop: false,
    statusPanelOpen: open,
    rightPanelMode: 'workspace',
    workModeRequested: requested,
    mediaComposerSurfaceId: mediaId,
  });
  return (
    <textarea
      data-work-mode={String(state.workModeActive)}
      data-full-window={String(state.fullWindowActive)}
      defaultValue="same draft"
    />
  );
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  writeShellPresentation('v2');
  useF307ExperienceWorkbenchStore.setState({
    layout: createInitialWorkbenchState(),
    artifactWorkPresentation: createArtifactWorkPresentationState(),
    mainAreaAttentionSurfaceId: null,
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  writeShellPresentation('classic');
  useF307ExperienceWorkbenchStore.setState({
    layout: createInitialWorkbenchState(),
    artifactWorkPresentation: createArtifactWorkPresentationState(),
  });
});
it.each([
  'cover.png',
  'clip.mp4',
])('retains explicit %s work mode across request consumption and owner loading on mobile', (path) => {
  const file = createFileSurface({
    worktreeId: 'wt-a',
    path,
    navigationOrigin: { kind: 'chat-file-link', threadId: 'thread-a', messageId: 'original' },
  });
  useF307ExperienceWorkbenchStore.setState({ layout: createInitialWorkbenchState([file]) });
  act(() => enterArtifactWorkMode('thread-a', file));
  const admitted = useF307ExperienceWorkbenchStore.getState().artifactWorkPresentation.session;
  act(() => root.render(<Host requested mediaId={null} />));
  expect(useF307ExperienceWorkbenchStore.getState().artifactWorkPresentation.session).toBe(admitted);
  const composer = container.querySelector('textarea');
  if (!composer) throw new Error('original composer required');
  composer.value = 'unsaved same composer';
  act(() => root.render(<Host requested={false} mediaId={file.id} />));
  expect(container.querySelector('textarea')).toBe(composer);
  expect(composer.value).toBe('unsaved same composer');
  expect(composer.dataset.workMode).toBe('true');
  expect(composer.dataset.fullWindow).toBe('false');
  expect(useF307ExperienceWorkbenchStore.getState().artifactWorkPresentation.session).toBe(admitted);
  act(() => root.render(<Host requested={false} mediaId={file.id} open={false} />));
  expect(useF307ExperienceWorkbenchStore.getState().artifactWorkPresentation.session).toBeNull();
  expect(container.querySelector('textarea')).toBe(composer);
});
it('does not retain an ordinary desktop fullscreen session on a narrow host', () => {
  const file = createFileSurface({ worktreeId: 'wt-a', path: 'cover.png' });
  useF307ExperienceWorkbenchStore.setState({ layout: createInitialWorkbenchState([file]) });
  act(() => toggleArtifactWorkFullWindow('thread-a', file));
  act(() => root.render(<Host requested={false} mediaId={file.id} />));
  expect(useF307ExperienceWorkbenchStore.getState().artifactWorkPresentation.session).toBeNull();
  expect(container.querySelector('textarea')?.dataset.workMode).toBe('false');
});
