import type { MessageMediaPublicationSource, ThreadArtifactDTO } from '@cat-cafe/shared';
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, vi } from 'vitest';
import { ArtworkLightboxHost } from '@/components/content-review/ArtworkLightboxHost';
import { ArtworkLightboxProvider } from '@/components/content-review/ArtworkLightboxScope';
import { writeShellLanguage } from '@/components/shell/shell-language';
import { writeShellPresentation } from '@/components/shell/shell-presentation';
import { artifactObjectId } from '@/components/workbench/real-surface-adapters';
import type { WorkspaceSurfaceDescriptor } from '@/components/workbench/workbench-contract';
import { useChatStore } from '@/stores/chatStore';
import { WorkspaceHomeV2 } from '../WorkspaceHomeV2';
import { command, live, NOW, seed } from './home-fixtures';

const mocks = vi.hoisted(() => ({
  artifacts: [] as ThreadArtifactDTO[],
  loading: false,
  error: false,
  refetch: vi.fn(),
  fetch: vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(),
  surfaces: [] as WorkspaceSurfaceDescriptor[],
}));
export const data = mocks;
vi.mock('@/hooks/useThreadArtifacts', () => ({
  useThreadArtifacts: () => ({ ...mocks, works: mocks.artifacts, total: mocks.artifacts.length, complete: true }),
}));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    getCatById: (id: string) => ({ id, displayName: id, color: { primary: 'var(--color-codex-primary)' } }),
  }),
}));
vi.mock('@/hooks/useDeploymentWaitProjection', () => ({
  useDeploymentWaitProjection: () => ({ projection: null, hydration: 'ready', retry: vi.fn() }),
}));
vi.mock('@/hooks/useActiveExecutionProjection', () => ({ cancelProjectedExecution: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ API_URL: '', apiFetch: mocks.fetch }));
// Only the renderer's editing internals stop at this boundary. Home, source admission,
// useContentOpen, scope, Host, Lightbox and gallery all run their production implementations.
vi.mock('@/components/workbench/F307OwnerSurfaceRenderer', () => ({
  F307OwnerSurfaceRenderer: ({ surface }: { surface: WorkspaceSurfaceDescriptor }) => {
    mocks.surfaces.push(surface);
    return <div data-testid="home-publication-owner" data-owner-key={surface.ownerStateRef.key} />;
  },
}));

export const imageArtifact: ThreadArtifactDTO = {
  type: 'image',
  name: '这一件精确图片',
  catId: 'codex61-sol',
  createdAt: NOW,
  sourceMessageId: 'source-message-exact',
  url: '/uploads/exact.png',
  publicationItem: { kind: 'content-block', index: 0 },
};
export const imageAsset = {
  contentRef: `prepared-media:${'c'.repeat(64)}`,
  ownerRevision: 1,
  blobDigest: `sha256:${'a'.repeat(64)}`,
  mediaType: 'image/png',
  media: { kind: 'image', width: 160, height: 100 },
  sourcePublication: {
    artifactRef: imageArtifact.url,
    sourceRef: 'message:thread-here:source-message-exact',
    revision: String(NOW),
  },
  ownerReceiptRef: 'receipt-exact',
};
export const props = {
  threadId: 'thread-here',
  defaultCatId: 'codex61-sol',
  worktreeId: null,
  destinationMessage: null,
  onSelectDevSurface: vi.fn(),
  onSelectDestination: vi.fn(),
  onSelectExecution: vi.fn(),
  onOpenArtifact: vi.fn(),
};

export function homeContentFixture() {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    localStorage.clear();
    writeShellLanguage('zh');
    writeShellPresentation('v2');
    data.loading = false;
    data.error = false;
    data.refetch.mockReset();
    data.fetch.mockReset();
    data.surfaces.length = 0;
    props.onOpenArtifact.mockReset();
    data.fetch.mockImplementation(async (url, init) => {
      if (url !== '/api/content-publications/resolve') return Response.json({ sessions: [] });
      const { source } = JSON.parse(String(init?.body)) as { source: MessageMediaPublicationSource };
      return Response.json({
        status: 'resolved',
        ownerUserId: 'operator',
        asset:
          source.expectedUrl === imageArtifact.url
            ? imageAsset
            : {
                ...imageAsset,
                contentRef: `prepared-media:${'d'.repeat(64)}`,
                sourcePublication: {
                  artifactRef: source.expectedUrl,
                  sourceRef: `message:${source.threadId}:${source.messageId}`,
                  revision: source.messageRevision,
                },
              },
      });
    });
    useChatStore.setState({
      currentThreadId: 'thread-here',
      threadStates: {},
      messages: [],
      catInvocations: {},
      catStatuses: {},
      catStatusDetails: {},
      activeInvocations: {},
      hasActiveInvocation: false,
      targetCats: [],
      workspaceOpenRequest: null,
      threads: [
        {
          id: 'thread-here',
          title: '完整的当前对话名称',
          projectPath: '/project',
          createdBy: 'user',
          createdAt: 1,
          lastActiveAt: 1,
          participants: [],
        },
      ],
    });
    data.artifacts = [
      imageArtifact,
      {
        type: 'pr',
        name: '真实变更',
        ref: 'org/repo#42',
        catId: 'codex61-sol',
        createdAt: NOW - 1000,
        sourceMessageId: null,
      },
    ];
    seed([
      live('codex61-sol', 'thread-here', '当前对话', 'live-1'),
      command('codex61-sol', 'thread-here', 'hold-1', 'test', NOW - 1000),
      ...Array.from({ length: 18 }, (_, index) =>
        live('codex61-sol', `thread-${index}`, `并行对话 ${index}`, `live-${index + 2}`),
      ),
    ]);
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    localStorage.clear();
    vi.unstubAllGlobals();
  });
  return {
    get host() {
      return host;
    },
    render: async (overrides: Partial<ComponentProps<typeof WorkspaceHomeV2>> = {}) => {
      const current = { ...props, ...overrides };
      await act(async () =>
        root.render(
          <ArtworkLightboxProvider threadId={current.threadId}>
            <WorkspaceHomeV2 {...current} />
            <ArtworkLightboxHost />
          </ArtworkLightboxProvider>,
        ),
      );
    },
    card: (artifact = imageArtifact) => {
      const card = [...host.querySelectorAll<HTMLButtonElement>('button[data-home-artifact-id]')].find(
        (node) => node.dataset.homeArtifactId === artifactObjectId(artifact),
      );
      if (!card) throw new Error(`Missing exact Home card: ${artifact.name}`);
      return card;
    },
    open: async (artifact = imageArtifact) => {
      const card = [...host.querySelectorAll<HTMLButtonElement>('button[data-home-artifact-id]')].find(
        (node) => node.dataset.homeArtifactId === artifactObjectId(artifact),
      );
      if (!card) throw new Error(`Missing exact Home card: ${artifact.name}`);
      // HTMLElement.click() does not perform a browser's pointer focus in JSDOM.
      card.focus();
      await act(async () => card.click());
      return card;
    },
  };
}
export async function escapePreview() {
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
}
