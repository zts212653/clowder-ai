import type { ThreadArtifactDTO } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ArtifactsPanel } from '@/components/ArtifactsPanel';
import { ThreadWorksPanelV2 } from '@/components/artifacts/ThreadWorksPanelV2';
import { writeShellLanguage } from '@/components/shell/shell-language';
import { writeShellPresentation } from '@/components/shell/shell-presentation';
import { resolveFileTarget } from '@/components/workbench/real-surface-adapters';
import type { WorkspaceSurfaceDescriptor } from '@/components/workbench/workbench-contract';
import { HomeWorksSummary } from '@/components/workspace-home/HomeWorksSummary';
import { useChatStore } from '@/stores/chatStore';

const calls = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ API_URL: 'http://api.test', apiFetch: calls.fetch }));
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ getCatById: () => undefined }) }));
const path = '.cat-cafe/uploads/1793117177832-4c1c74e5.md';
const worktreeId = 'real-upload-root';
const artifact: ThreadArtifactDTO = {
  type: 'file',
  name: 'Clowder_AI_后续建设与分工讨论稿-v0_2.md',
  mime: 'text/markdown',
  url: `/api/workspace/file/raw?${new URLSearchParams({ worktreeId, path })}`,
  createdAt: 20,
  catId: 'codex-astra',
  sourceMessageId: 'exact-raw-message',
  publicationItem: { kind: 'rich-file', blockId: 'real-raw-md' },
};
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  writeShellLanguage('en');
  useChatStore.setState({ currentThreadId: 'host', messages: [], threadStates: {}, workspaceOpenRequest: null });
  calls.fetch.mockImplementation(async () =>
    Response.json({
      threadId: 'host',
      artifacts: [artifact],
      view: 'works',
      complete: true,
      total: 1,
      workLineage: 'resolved',
    }),
  );
  host = document.createElement('div');
  host.dataset.testid = 'f307-workspace-home-page';
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it.each([
  'works',
  'home',
  'classic',
] as const)('%s hands the resolved raw document target to its Host, retaining the entry return', async (entry) => {
  writeShellPresentation(entry === 'classic' ? 'classic' : 'v2');
  const attached = vi.fn();
  await act(async () =>
    root.render(
      entry === 'works' ? (
        <ThreadWorksPanelV2 threadId="host" onSelectArtifact={attached} />
      ) : entry === 'home' ? (
        <HomeWorksSummary threadId="host" worktreeId={null} onSelectDestination={vi.fn()} onOpenArtifact={attached} />
      ) : (
        <ArtifactsPanel threadId="host" onSelectArtifact={attached} />
      ),
    ),
  );
  const card = host.querySelector<HTMLButtonElement>(
    entry === 'home'
      ? '[data-testid="workspace-home-artifact-card"]'
      : entry === 'classic'
        ? '[data-artifact-row]'
        : '.work-gallery-open',
  );
  expect(card).not.toBeNull();
  await act(async () => card?.click());
  expect(attached).toHaveBeenCalledTimes(1);
  const [original, origin, resolved] = attached.mock.calls[0] as [
    ThreadArtifactDTO,
    NonNullable<WorkspaceSurfaceDescriptor['navigationOrigin']>,
    WorkspaceSurfaceDescriptor,
  ];
  expect(original).toEqual(artifact);
  expect(origin.kind).toBe(entry === 'home' ? 'workspace-home-artifact' : 'artifact-list');
  expect(resolved).toMatchObject({
    type: 'file',
    renderer: 'file-preview',
    navigationOrigin: origin,
    objectRef: { kind: 'file', id: worktreeId },
    ownerStateRef: { key: worktreeId },
  });
  expect(resolveFileTarget(resolved)).toMatchObject({ worktreeId, path });
  expect(useChatStore.getState().workspaceOpenRequest).toBeNull();
});
