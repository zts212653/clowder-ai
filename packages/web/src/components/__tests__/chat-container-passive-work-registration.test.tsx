import type { MediaContextAttachment } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CHAT_LAYOUT_CHANGED_EVENT, isChatReadingCaptureRequest } from '@/utils/chat-layout-change';
import { writeShellPresentation } from '../shell/shell-presentation';
import { createArtifactReviewSurface } from '../workbench/artifact-review-surface';
import { useF307ExperienceWorkbenchStore } from '../workbench/experience-workbench-store';
import type { useWorkspaceChatWorkScope } from '../workbench/WorkspaceChatWorkScope';
import { renderChatContainer, resetChatContainerMocks, storeState } from './chat-container-test-helpers';

let workScope: ReturnType<typeof useWorkspaceChatWorkScope>;

vi.mock('@/components/thread-chat/hub-socket-context', () => import('@/test-utils/hub-socket-context-mock'));
vi.mock('../execution-row/ExecutionRow', () => ({ ExecutionRow: () => null }));

vi.mock('../workbench/WorkspaceChatWorkScope', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workbench/WorkspaceChatWorkScope')>();
  function ScopeProbe() {
    workScope = actual.useWorkspaceChatWorkScope();
    return null;
  }
  return {
    ...actual,
    WorkspaceChatWorkScopeProvider(props: React.ComponentProps<typeof actual.WorkspaceChatWorkScopeProvider>) {
      return (
        <actual.WorkspaceChatWorkScopeProvider {...props}>
          <ScopeProbe />
          {props.children}
        </actual.WorkspaceChatWorkScopeProvider>
      );
    },
  };
});

const reviewId = `review-${'a'.repeat(64)}`;
const surface = createArtifactReviewSurface(reviewId, 'thread-a', 'Existing work', 1);
const attachment: MediaContextAttachment = {
  v: 1,
  id: 'restored-work',
  kind: 'media',
  title: 'Existing work',
  mediaType: 'image/png',
  source: { kind: 'artifact-review', reviewId, round: 1, expectedReviewRevision: 1 },
  selections: [],
};
let host: HTMLDivElement;
let root: Root;
let captures: Event[];
const observe = (event: Event) => {
  if (isChatReadingCaptureRequest(event)) captures.push(event);
};

beforeEach(() => {
  (globalThis as { React?: typeof React }).React = React;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  resetChatContainerMocks();
  Object.assign(storeState, { currentThreadId: 'thread-a', rightPanelMode: 'workspace', rightPanelOpen: true });
  writeShellPresentation('v2');
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  const initial = useF307ExperienceWorkbenchStore.getInitialState();
  useF307ExperienceWorkbenchStore.setState({
    ...initial,
    layout: { ...initial.layout, surfaces: [surface], activeSurfaceId: surface.id },
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  workScope = null;
  captures = [];
  window.addEventListener(CHAT_LAYOUT_CHANGED_EVENT, observe);
});

afterEach(() => {
  act(() => root.unmount());
  window.removeEventListener(CHAT_LAYOUT_CHANGED_EVENT, observe);
  host.remove();
  writeShellPresentation('classic');
  useF307ExperienceWorkbenchStore.setState(useF307ExperienceWorkbenchStore.getInitialState());
  vi.restoreAllMocks();
});

it('hydrating and releasing work availability do not announce a new reading gesture', async () => {
  await act(async () => root.render(renderChatContainer('thread-a')));
  expect(workScope).not.toBeNull();
  captures.length = 0;
  let release: (() => void) | undefined;
  act(() => {
    release = workScope?.register({ threadId: 'thread-a', surfaceId: surface.id, attachment, isVisible: () => true });
  });
  expect(workScope?.read('thread-a')).toEqual(attachment);
  expect(captures, 'hydrating the retained work is not a new reading gesture').toEqual([]);
  act(() => release?.());
  expect(workScope?.read('thread-a')).toBeNull();
  expect(captures, 'releasing a work registration is not a new reading gesture').toEqual([]);
});
