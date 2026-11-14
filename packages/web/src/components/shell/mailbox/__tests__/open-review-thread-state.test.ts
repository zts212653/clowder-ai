// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest';
import { useF307ExperienceWorkbenchStore } from '@/components/workbench/experience-workbench-store';
import { createFileSurface } from '@/components/workbench/real-surface-adapters';
import { createInitialWorkbenchState } from '@/components/workbench/workbench-model';
import { bindWorkspaceForeground } from '@/components/workbench/workspace-presentation-lock';
import { DEFAULT_THREAD_STATE, useChatStore } from '@/stores/chatStore';
import { openExactPlace } from '../open-exact-place';

const outgoing = createFileSurface({ worktreeId: 'outgoing', path: 'outgoing.md' });
const saved = createFileSurface({ worktreeId: 'destination', path: 'saved.md' });
const reviewId = `review-${'a'.repeat(64)}`;
let unbind: () => void;

beforeEach(() => {
  window.history.replaceState({}, '', '/thread/thread-return');
  useChatStore.setState({
    ...DEFAULT_THREAD_STATE,
    currentThreadId: 'thread-return',
    presentationLock: null,
    threadStates: {},
    workspaceMode: 'dev',
    rightPanelMode: 'workspace',
    rightPanelOpen: true,
    workspaceForegroundSurfaceId: outgoing.id,
  });
  useF307ExperienceWorkbenchStore.setState({
    hydrated: true,
    layout: { ...createInitialWorkbenchState(), surfaces: [outgoing, saved], activeSurfaceId: outgoing.id },
  });
  unbind = bindWorkspaceForeground();
});
afterEach(() => unbind());

it.each([false, true])('keeps the review visible after destination restoration (saved workspace: %s)', (hasSaved) => {
  if (hasSaved) {
    useChatStore.setState({
      threadStates: {
        'thread-other': {
          ...DEFAULT_THREAD_STATE,
          workspaceMode: 'team',
          rightPanelOpen: false,
          workspaceForegroundSurfaceId: saved.id,
          workspaceWorktreeId: 'destination',
          workspaceOpenFilePath: 'saved.md',
        },
      },
    });
  }
  openExactPlace(`workspace:content-review:thread-other:${reviewId}`, window.location.pathname, (href) => {
    window.history.pushState({}, '', href);
  });
  // The arriving ChatContainer calls this even if navigation already selected the destination.
  useChatStore.getState().setCurrentThread('thread-other');
  expect(useChatStore.getState()).toMatchObject({
    currentThreadId: 'thread-other',
    workspaceForegroundSurfaceId: `content-review:${reviewId}`,
    workspaceMode: 'dev',
    rightPanelMode: 'workspace',
    rightPanelOpen: true,
  });
  expect(useF307ExperienceWorkbenchStore.getState().layout.activeSurfaceId).toBe(`content-review:${reviewId}`);
  expect(useChatStore.getState().threadStates['thread-return'].workspaceForegroundSurfaceId).toBe(outgoing.id);
});
