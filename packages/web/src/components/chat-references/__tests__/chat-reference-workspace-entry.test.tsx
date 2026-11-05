import type { ChatReferenceTarget } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createCommitChangesSurface } from '@/components/workbench/commit-changes-surface';
import { useF307ExperienceWorkbenchStore } from '@/components/workbench/experience-workbench-store';
import { createPullRequestChangesSurface } from '@/components/workbench/pull-request-changes-surface';
import {
  createFileSurface,
  resolveBrowserTarget,
  resolveFileTarget,
} from '@/components/workbench/real-surface-adapters';
import { createInitialWorkbenchState } from '@/components/workbench/workbench-model';
import { WORKBENCH_STORAGE_KEY } from '@/components/workbench/workbench-persistence';
import { bindWorkspaceForeground } from '@/components/workbench/workspace-presentation-lock';
import { useChatStore } from '@/stores/chatStore';
import { ChatReference } from '../ChatReference';

let target: ChatReferenceTarget;
vi.mock('../chat-reference-batch', () => ({
  chatReferenceBatch: { subscribe: () => () => {}, read: () => target },
}));

let root: Root, container: HTMLDivElement, unbind: (() => void) | undefined;
const threadId = 'thread-reference-workspace';
const sha = 'a'.repeat(40);
beforeEach(() => {
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  useChatStore.setState({
    currentThreadId: threadId,
    workspaceForegroundSurfaceId: null,
    workspaceMode: 'dev',
    workspaceSurface: 'home',
    workspaceOpenFilePath: null,
    workspaceOpenFileLine: null,
    workspaceWorktreeId: 'project',
    workspacePreview: { port: undefined, path: '/' },
    teamWorkspaceSubject: null,
    workspaceOpenRevision: 0,
    _workspaceFileSetAt: { ts: 0, threadId: null },
    presentationLock: null,
    threadStates: {},
  });
  useF307ExperienceWorkbenchStore.setState({ hydrated: false, layout: createInitialWorkbenchState() });
});
afterEach(() => {
  unbind?.();
  unbind = undefined;
  act(() => root.unmount());
  container.remove();
  localStorage.clear();
  vi.unstubAllGlobals();
});

for (const kind of ['commit', 'pull'] as const) {
  for (const state of ['before-host-mount', 'already-active-behind-Home'] as const) {
    it(`reveals ${kind} ${state} through the original chat control`, async () => {
      target =
        kind === 'commit'
          ? { kind: 'commit', sha, worktreeId: 'project', title: 'Commit' }
          : {
              kind: 'github',
              objectType: 'pull',
              repo: 'owner/repo',
              number: 5963,
              title: 'Pull request',
              state: 'merged',
              worktreeId: 'project',
              url: 'https://github.com/owner/repo/pull/5963',
            };
      const surface =
        kind === 'commit'
          ? createCommitChangesSurface({ sha, worktreeId: 'project', threadId })
          : createPullRequestChangesSurface({
              artifact: { type: 'pr', ref: 'owner/repo#5963', name: 'Pull request' },
              worktreeId: 'project',
              threadId,
            });
      if (!surface) throw new Error('The admitted fixture must have a canonical owner');
      const hydrated = state === 'already-active-behind-Home';
      const retained = createFileSurface({ worktreeId: 'project', path: 'kept.md' });
      if (!hydrated)
        localStorage.setItem(WORKBENCH_STORAGE_KEY, JSON.stringify(createInitialWorkbenchState([retained])));
      useF307ExperienceWorkbenchStore.setState({
        hydrated,
        layout: createInitialWorkbenchState(hydrated ? [surface] : []),
        focusSurfaceId: null,
        mainAreaAttentionSurfaceId: null,
      });
      if (hydrated) unbind = bindWorkspaceForeground();
      const reference = kind === 'commit' ? sha.slice(0, 10) : 'https://github.com/owner/repo/pull/5963';
      await act(async () =>
        root.render(
          <ChatReference reference={reference} threadId={threadId}>
            {reference}
          </ChatReference>,
        ),
      );
      const control = container.querySelector<HTMLButtonElement>('button');
      expect(control).not.toBeNull();
      await act(async () => control?.click());
      expect(useF307ExperienceWorkbenchStore.getState().layout.activeSurfaceId).toBe(surface.id);
      expect(useChatStore.getState().workspaceForegroundSurfaceId).toBe(surface.id);
      expect(useChatStore.getState().threadStates[threadId]?.workspaceForegroundSurfaceId).toBe(surface.id);
      if (!hydrated)
        expect(useF307ExperienceWorkbenchStore.getState().layout.surfaces.map((entry) => entry.id)).toContain(
          retained.id,
        );
      useF307ExperienceWorkbenchStore.getState().hydrate();
      expect(useChatStore.getState().workspaceForegroundSurfaceId).toBe(surface.id);
    });
  }

  for (const previous of ['files', 'browser'] as const) {
    it(`preserves the F284 ${previous} owner when ${kind} opens before host hydration`, async () => {
      useChatStore.setState({
        workspaceSurface: previous,
        workspaceOpenFilePath: 'legacy-kept.md',
        workspaceOpenFileLine: 17,
        workspacePreview: { port: 4319, path: '/legacy-kept' },
      });
      target =
        kind === 'commit'
          ? { kind: 'commit', sha, worktreeId: 'project', title: 'Commit' }
          : {
              kind: 'github',
              objectType: 'pull',
              repo: 'owner/repo',
              number: 5963,
              title: 'Pull request',
              state: 'merged',
              worktreeId: 'project',
              url: 'https://github.com/owner/repo/pull/5963',
            };
      await act(async () =>
        root.render(
          <ChatReference
            threadId={threadId}
            reference={kind === 'commit' ? sha.slice(0, 10) : 'https://github.com/owner/repo/pull/5963'}
          >
            Open changes
          </ChatReference>,
        ),
      );
      await act(async () => container.querySelector<HTMLButtonElement>('button')?.click());
      const state = useF307ExperienceWorkbenchStore.getState();
      const retained = state.layout.surfaces.find(
        (surface) => surface.type === (previous === 'files' ? 'file' : 'browser'),
      );
      expect(retained, 'the existing flat Workspace owner survives the new entry').toBeDefined();
      if (!retained) return;
      if (previous === 'files')
        expect(resolveFileTarget(retained)).toMatchObject({
          path: 'legacy-kept.md',
          scrollToLine: 17,
          worktreeId: 'project',
        });
      else expect(resolveBrowserTarget(retained)).toMatchObject({ port: 4319, path: '/legacy-kept' });
      expect(state.hydrated).toBe(true);
      expect(state.layout.surfaces.find((surface) => surface.id === state.layout.activeSurfaceId)?.type).toBe(
        'workspace',
      );
      expect(useChatStore.getState().workspaceForegroundSurfaceId).toBe(state.layout.activeSurfaceId);
    });
  }
}

it('keeps a previously rendered reference inert after the active conversation changes', async () => {
  target = { kind: 'commit', sha, worktreeId: 'project', title: 'Commit' };
  await act(async () =>
    root.render(
      <ChatReference reference={sha.slice(0, 10)} threadId={threadId}>
        Commit
      </ChatReference>,
    ),
  );
  act(() => useChatStore.setState({ currentThreadId: 'another-thread' }));
  await act(async () => container.querySelector<HTMLButtonElement>('button')?.click());
  expect(useF307ExperienceWorkbenchStore.getState().layout.surfaces).toHaveLength(0);
  expect(useChatStore.getState().workspaceForegroundSurfaceId).toBeNull();
  expect(container.querySelector('[role=alert]')).not.toBeNull();
});
