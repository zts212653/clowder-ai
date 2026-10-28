import type { GlobalArtifactDTO } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { ArtifactsPanel } from '../ArtifactsPanel';
import type { ArtifactListView } from '../artifacts/artifact-list-state';

const opened = vi.hoisted(() => ({ resolve: vi.fn() }));
const rows = vi.hoisted(() => ({ image: undefined as GlobalArtifactDTO | undefined }));

const artifact: GlobalArtifactDTO = {
  type: 'code',
  name: 'proposal.ts',
  ref: '/original/proposal.ts',
  createdAt: 7,
  catId: 'opus5',
  sourceMessageId: null,
  threadId: 'original-thread',
  threadTitle: '原对话',
};
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ getCatById: () => undefined }) }));
vi.mock('@/hooks/useThreadArtifacts', () => ({
  useThreadArtifacts: () => ({ artifacts: [], loading: false, error: false }),
}));
vi.mock('@/hooks/useGlobalArtifacts', () => ({
  useGlobalArtifacts: () => ({ artifacts: [rows.image ?? artifact], loading: false, error: false }),
}));
vi.mock('../content-review/usePublishedContent', async (original) => ({
  ...(await original<typeof import('../content-review/usePublishedContent')>()),
  usePublishedContent: () => ({ open: opened.resolve, clearError: vi.fn(), busy: false, error: null }),
}));
vi.mock('../artifacts/ArtifactDetailView', () => ({ ArtifactDetailView: () => <div data-testid="weak-preview" /> }));
const view: ArtifactListView = {
  scope: 'global',
  filter: 'codepr',
  query: 'proposal',
  grouping: 'none',
  catFilter: null,
  collapsed: ['other-thread'],
};
const container = document.createElement('div');
const root = createRoot(container);
beforeEach(() => {
  rows.image = undefined;
  opened.resolve.mockImplementation(async (source: unknown) => ({
    status: 'opened',
    target: {
      kind: 'publication',
      contentRef: 'prepared-media:' + 'a'.repeat(64),
      ownerRevision: 1,
      messagePublicationSource: source,
    },
  }));
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

it.each([
  'jpg',
  'webp',
])('the standalone %s list keeps the exact publication and list return in the original owner pipeline', async (extension) => {
  rows.image = {
    ...artifact,
    type: 'image',
    name: `original.${extension}`,
    ref: undefined,
    url: `/uploads/original.${extension}`,
    sourceMessageId: 'original-message',
    publicationItem: { kind: 'rich-file', blockId: 'original-file' },
  };
  useChatStore.setState({ currentThreadId: 'list-host-thread', workspaceOpenRequest: null });
  await act(async () =>
    root.render(<ArtifactsPanel threadId="list-host-thread" initialView={{ ...view, filter: 'all', query: '' }} />),
  );
  await act(async () => container.querySelector<HTMLElement>('[data-artifact-row]')?.click());
  expect(useChatStore.getState().workspaceOpenRequest).toBeNull();
  await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="lightbox-open-workspace"]')?.click());
  expect(container.querySelector('[data-testid="weak-preview"]')).toBeNull();
  expect(useChatStore.getState().workspaceOpenRequest?.target).toMatchObject({
    kind: 'publication',
    messagePublicationSource: {
      threadId: 'original-thread',
      messageId: 'original-message',
      expectedUrl: `/uploads/original.${extension}`,
    },
    navigationOrigin: { kind: 'artifact-list', threadId: 'list-host-thread' },
  });
});
afterEach(() => {
  act(() => root.render(null));
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

it('restores the original global scope/query and captures them separately from the artifact owner thread', async () => {
  const selected = vi.fn();
  await act(async () =>
    root.render(<ArtifactsPanel threadId="list-host-thread" initialView={view} onSelectArtifact={selected} />),
  );
  expect(container.querySelector('input')?.value).toBe('proposal');
  const row = container.querySelector<HTMLElement>('[data-artifact-row]');
  expect(row).toBeTruthy();
  act(() => row!.click());
  expect(selected).toHaveBeenCalledWith(artifact, { kind: 'artifact-list', threadId: 'list-host-thread', view });
});

it('the standalone list opens a repository file in the canonical Workbench pipeline with its return state', async () => {
  useChatStore.setState({ currentThreadId: 'list-host-thread', workspaceOpenRequest: null });
  await act(async () => root.render(<ArtifactsPanel threadId="list-host-thread" initialView={view} />));
  act(() => container.querySelector<HTMLElement>('[data-artifact-row]')!.click());
  expect(container.querySelector('[data-testid="weak-preview"]')).toBeNull();
  expect(useChatStore.getState().workspaceOpenRequest?.target).toMatchObject({
    kind: 'artifact',
    artifact: { threadId: 'original-thread' },
    navigationOrigin: { kind: 'artifact-list', threadId: 'list-host-thread', view },
  });
});
