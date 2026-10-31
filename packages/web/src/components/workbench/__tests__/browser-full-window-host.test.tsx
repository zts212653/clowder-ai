// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { writeShellPresentation } from '../../shell/shell-presentation';
import { createArtifactWorkPresentationState } from '../artifact-work-presentation';
import { toggleArtifactWorkFullWindow } from '../artifact-work-presentation-actions';
import { useF307ExperienceWorkbenchStore } from '../experience-workbench-store';
import { createArtifactSurface, createBrowserSurface } from '../real-surface-adapters';
import { useArtifactWorkHostPresentation } from '../useArtifactWorkHostPresentation';
import { createInitialWorkbenchState } from '../workbench-model';

const browser = createBrowserSurface({ ownerKey: 'chess-owner', port: 5324, path: '/chess' });
let container: HTMLDivElement;
let root: Root;

function Host({ threadId = 'thread-a' }: { threadId?: string }) {
  const presentation = useArtifactWorkHostPresentation({
    threadId,
    viewMode: 'single',
    isDesktop: true,
    statusPanelOpen: true,
    rightPanelMode: 'workspace',
  });
  return (
    <div data-eligible={String(presentation.hostEligible)} data-full-window={String(presentation.fullWindowActive)} />
  );
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  writeShellPresentation('v2');
  useF307ExperienceWorkbenchStore.setState({
    layout: createInitialWorkbenchState([browser]),
    hydrated: true,
    focusSurfaceId: browser.id,
    mainAreaAttentionSurfaceId: null,
    artifactWorkPresentation: createArtifactWorkPresentationState(),
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
    focusSurfaceId: null,
    artifactWorkPresentation: createArtifactWorkPresentationState(),
  });
});

it('uses the original full-window session for the v2 browser and retains its owner and focus on return', () => {
  const layout = useF307ExperienceWorkbenchStore.getState().layout;
  act(() => root.render(<Host />));
  expect(container.firstElementChild?.getAttribute('data-eligible')).toBe('true');
  act(() => toggleArtifactWorkFullWindow('thread-a', browser));
  expect(container.firstElementChild?.getAttribute('data-full-window')).toBe('true');
  expect(useF307ExperienceWorkbenchStore.getState().layout).toBe(layout);
  expect(useF307ExperienceWorkbenchStore.getState().artifactWorkPresentation.session?.returnHandle.client).toBe(
    browser.ownerStateRef,
  );
  act(() => toggleArtifactWorkFullWindow('thread-a', browser));
  expect(container.firstElementChild?.getAttribute('data-full-window')).toBe('false');
  expect(useF307ExperienceWorkbenchStore.getState().layout).toBe(layout);
  expect(useF307ExperienceWorkbenchStore.getState().focusSurfaceId).toBe(browser.id);
});

it('keeps classic browser projection outside the full-window host while existing artifacts remain eligible', () => {
  writeShellPresentation('classic');
  act(() => root.render(<Host />));
  expect(container.firstElementChild?.getAttribute('data-eligible')).toBe('false');
  const artifact = createArtifactSurface({
    threadId: 'thread-a',
    artifact: {
      type: 'image',
      name: 'Board',
      catId: 'codex61-sol',
      createdAt: 1791060000000,
      ref: 'board',
      sourceMessageId: null,
    },
  });
  act(() => useF307ExperienceWorkbenchStore.setState({ layout: createInitialWorkbenchState([artifact]) }));
  expect(container.firstElementChild?.getAttribute('data-eligible')).toBe('true');
});
