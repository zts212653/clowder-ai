// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { writeShellPresentation } from '@/components/shell/shell-presentation';
import { useChatStore } from '@/stores/chatStore';
import { createArtifactWorkPresentationState } from '../artifact-work-presentation';
import { useF307ExperienceWorkbenchStore } from '../experience-workbench-store';
import { F307ExperienceWorkbench } from '../F307ExperienceWorkbench';
import { createWorkspaceDestinationSurface, resolveChangesTarget, resolveFileTarget } from '../real-surface-adapters';
import { createInitialWorkbenchState } from '../workbench-model';

Object.assign(globalThis as Record<string, unknown>, { React });
const api = vi.hoisted(() => ({ requests: [] as string[], readable: true }));
const canonicalWorktreeId = `f063_root_v1_${'1'.repeat(64)}`;
vi.mock('@/hooks/useIsDesktop', () => ({ useIsDesktop: () => true }));
// The review strip is unrelated to opening a diff. Changes, DiffViewer, FileOwner,
// the renderer and the Workbench callbacks below are the real production tree.
vi.mock('@/components/ThreadSidebar/ThreadNativeReviewSettings', () => ({
  ThreadNativeReviewSettingsContent: () => <div />,
}));
vi.mock('@/utils/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/api-client')>();
  return {
    ...actual,
    apiFetch: async (input: string) => {
      api.requests.push(input);
      if (input === '/api/workspace/resolve-file-source')
        return Response.json({ worktreeId: canonicalWorktreeId, path: 'src/a.ts', kind: 'file' });
      if (input.startsWith('/api/workspace/diff'))
        return Response.json({
          changedFiles: [
            { status: 'M', path: 'src/a.ts' },
            { status: 'M', path: 'src/b.ts' },
          ],
          diff: ['a', 'b']
            .map(
              (name) =>
                `diff --git a/src/${name}.ts b/src/${name}.ts\n--- a/src/${name}.ts\n+++ b/src/${name}.ts\n@@ -1 +1 @@\n-old\n+new\n`,
            )
            .join(''),
        });
      if (input.startsWith('/api/workspace/file?'))
        return api.readable
          ? Response.json({
              path: 'src/a.ts',
              content: 'const value = 1;',
              mime: 'text/plain',
              size: 16,
              sha256: 'a'.repeat(64),
              truncated: false,
              binary: false,
            })
          : new Response('forbidden', { status: 403 });
      return Response.json({});
    },
  };
});

const changes = createWorkspaceDestinationSurface(
  { kind: 'surface', id: 'changes', label: '变更', description: 'Diff', searchTerms: 'changes' },
  'thread-a',
  'listed-worktree',
)!;
let host: HTMLDivElement;
let root: Root;
async function settle(action: () => void) {
  await act(async () => {
    action();
    for (let i = 0; i < 12; i++) await Promise.resolve();
  });
}
function button(owner: Element, text: string) {
  const found = [...owner.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === text,
  );
  expect(found, `actual button ${text}`).toBeDefined();
  return found!;
}
function owner(id: string) {
  const found = [...host.querySelectorAll<HTMLElement>('article[data-surface-id]')].find(
    (item) => item.dataset.surfaceId === id,
  );
  expect(found, `mounted owner ${id}`).toBeDefined();
  return found!;
}
beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  writeShellPresentation('v2');
  api.requests.length = 0;
  api.readable = true;
  useChatStore.setState({ currentThreadId: 'thread-a', presentationLock: null });
  useF307ExperienceWorkbenchStore.setState({
    hydrated: true,
    layout: createInitialWorkbenchState([changes]),
    focusSurfaceId: null,
    mainAreaAttentionSurfaceId: null,
    artifactWorkPresentation: createArtifactWorkPresentationState(),
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await settle(() =>
    root.render(
      <F307ExperienceWorkbench
        threadId="thread-a"
        worktreeId="listed-worktree"
        openFilePath={null}
        preview={{ path: '/' }}
        onSelectDevSurface={() => undefined}
        onOpenAppRoute={() => undefined}
      />,
    ),
  );
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  localStorage.clear();
  useF307ExperienceWorkbenchStore.setState({
    layout: createInitialWorkbenchState(),
    focusSurfaceId: null,
    mainAreaAttentionSurfaceId: null,
    artifactWorkPresentation: createArtifactWorkPresentationState(),
  });
  useChatStore.setState({ presentationLock: null });
});

it('opens the real diff action and returns to the same selected diff DOM, mode and scroll', async () => {
  const initialDiffRequests = api.requests.filter((input) => input.startsWith('/api/workspace/diff')).length;
  expect(initialDiffRequests).toBeGreaterThan(0);
  const original = owner(changes.id);
  const fileChoice = [...original.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.includes('a.ts') && !item.textContent?.includes('打开文件'),
  )!;
  await settle(() => fileChoice.click());
  await settle(() => button(original, '并排').click());
  const mode = button(original, '并排');
  // Use the actual scroll container class rather than inventing a callback seam.
  const scroll = [...original.querySelectorAll<HTMLElement>('div')].find(
    (item) => item.className.includes('overflow-auto') && item.className.includes('ws-editor-deep'),
  )!;
  expect(scroll).toBeDefined();
  scroll.scrollTop = 137;
  await settle(() => button(original, '打开文件').click());
  const layout = useF307ExperienceWorkbenchStore.getState().layout;
  const file = layout.surfaces.find((item) => item.id === layout.activeSurfaceId)!;
  expect(resolveFileTarget(file)).toMatchObject({ worktreeId: canonicalWorktreeId, path: 'src/a.ts' });
  expect(file.navigationOrigin).toEqual({
    kind: 'workspace-changes',
    worktreeId: 'listed-worktree',
    threadId: 'thread-a',
  });
  expect(owner(file.id).textContent).toContain('const value = 1;');
  // Chromium clamps this retained viewport to zero when the owner is display:none.
  // The hidden scroll event is layout fallout, not a new reading position.
  expect(original.classList.contains('hidden')).toBe(true);
  scroll.scrollTop = 0;
  await settle(() => scroll.dispatchEvent(new Event('scroll')));
  await settle(() => button(owner(file.id), '‹ 变更').click());
  expect(useF307ExperienceWorkbenchStore.getState().layout.activeSurfaceId).toBe(changes.id);
  expect(resolveChangesTarget(changes)).toEqual({ worktreeId: 'listed-worktree', threadId: 'thread-a' });
  expect(owner(changes.id)).toBe(original);
  expect(button(original, '并排')).toBe(mode);
  expect(mode.className).toContain('bg-cafe-accent');
  expect(scroll.scrollTop).toBe(137);
  expect(
    [...original.querySelectorAll('button')].filter((item) => item.textContent?.trim() === '打开文件'),
  ).toHaveLength(1);
  // Compare with the settled initial mount: this journey protects return continuity,
  // including no new diff fetch when the retained owner becomes visible again.
  expect(api.requests.filter((input) => input.startsWith('/api/workspace/diff'))).toHaveLength(initialDiffRequests);
});

it('keeps a failed file read in the original owner and offers a real return to Changes', async () => {
  api.readable = false;
  const original = owner(changes.id);
  await settle(() => button(original, '打开文件').click());
  const layout = useF307ExperienceWorkbenchStore.getState().layout;
  const file = layout.surfaces.find((item) => item.id === layout.activeSurfaceId)!;
  expect(owner(file.id).textContent).toContain('暂时无法读取此文件');
  expect(owner(file.id).querySelector('[data-testid="v2-file-chrome"]')).toBeNull();
  await settle(() => button(owner(file.id), '‹ 变更').click());
  expect(useF307ExperienceWorkbenchStore.getState().layout.activeSurfaceId).toBe(changes.id);
  expect(owner(changes.id)).toBe(original);
});
