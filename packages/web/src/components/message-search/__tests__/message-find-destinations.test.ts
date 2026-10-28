import { beforeEach, expect, it, vi } from 'vitest';
import { assignDocumentRoute } from '@/components/ThreadSidebar/thread-navigation';
import { useF307ExperienceWorkbenchStore } from '@/components/workbench/experience-workbench-store';
import { createInitialWorkbenchState } from '@/components/workbench/workbench-model';
import { useChatStore } from '@/stores/chatStore';
import {
  captureFindWorkspaceOrigin,
  openMessageFindDestination,
  restoreFindWorkspaceOrigin,
} from '../message-find-destinations';
import { startMessageReadingSession } from '../message-reading-session';

vi.mock('@/components/ThreadSidebar/thread-navigation', () => ({ assignDocumentRoute: vi.fn() }));
beforeEach(() => {
  localStorage.clear();
  vi.mocked(assignDocumentRoute).mockClear();
  useF307ExperienceWorkbenchStore.setState({ layout: createInitialWorkbenchState(), mainAreaAttentionSurfaceId: null });
  useChatStore.setState({
    currentThreadId: 'origin',
    rightPanelMode: 'status',
    rightPanelOpen: false,
    workspaceOpenRequest: null,
    workspaceForegroundSurfaceId: null,
  });
});
function session(destination: 'works' | 'memory') {
  return startMessageReadingSession(
    {
      searchId: 'same-result',
      origin: { threadId: 'origin', readingRef: 'opaque' },
      targets: [],
      generation: 0,
      settledIndex: null,
      pending: null,
      status: 'ready',
    },
    true,
    {
      destination,
      state: { query: '一行 & 一起', scope: 'global', sort: 'relevance', scrollTop: 214, status: 'idle' },
      workspaceOrigin: captureFindWorkspaceOrigin(),
    },
  ).session;
}
it('opens the original Works destination with its own name query and restores original chrome before J5 recovery', () => {
  const saved = session('works');
  openMessageFindDestination(saved);
  const store = useF307ExperienceWorkbenchStore.getState();
  const surface = store.layout.surfaces.find((candidate) => candidate.id === store.layout.activeSurfaceId);
  expect(surface).toMatchObject({
    renderer: 'workspace-destination',
    objectRef: { id: 'mode:artifacts' },
    artifactListView: { query: '一行 & 一起', scope: 'global', findSessionId: saved.id },
  });
  expect(useChatStore.getState().rightPanelMode).toBe('workspace');
  expect(useChatStore.getState().rightPanelOpen).toBe(true);
  expect(useChatStore.getState().workspaceForegroundSurfaceId).toBe(surface?.id);
  expect(useChatStore.getState().workspaceOpenRequest).toBeNull();
  restoreFindWorkspaceOrigin(saved);
  expect(useChatStore.getState().rightPanelMode).toBe('status');
  expect(useChatStore.getState().rightPanelOpen).toBe(false);
  expect(useChatStore.getState().workspaceForegroundSurfaceId).toBeNull();
  expect(assignDocumentRoute).not.toHaveBeenCalled();
});
it('hands the original Memory page an encoded query and the original J5 session, without creating a search', () => {
  const saved = session('memory');
  openMessageFindDestination(saved);
  expect(assignDocumentRoute).toHaveBeenCalledOnce();
  const href = vi.mocked(assignDocumentRoute).mock.calls[0][0];
  const url = new URL(href, 'https://local.test');
  expect(url.pathname).toBe('/memory');
  expect(Object.fromEntries(url.searchParams)).toEqual({ from: 'origin', q: '一行 & 一起', findSession: saved.id });
  expect(useF307ExperienceWorkbenchStore.getState().layout.activeSurfaceId).toBeNull();
});
