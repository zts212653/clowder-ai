'use client';

import type { ListenDocumentState } from '@cat-cafe/shared';
import type {
  ListenDocumentCacheProjection,
  ListenDocumentDescriptor,
  ListenModeSession,
} from '@/stores/listenModeStore';
import { listenDocumentCacheKey, useListenModeStore } from '@/stores/listenModeStore';
import type { ListenModeApi, LoadedListenDocument } from './listenModeApi';
import { listenModeApi } from './listenModeApi';

const CACHE_POLL_MS = 600;

interface CacheControllerDependencies {
  api: Pick<ListenModeApi, 'load' | 'save' | 'startCache' | 'cancelCache' | 'clearAudio'>;
  now: () => number;
  schedule: (callback: () => void) => unknown;
  clear: (handle: unknown) => void;
}

const defaultDependencies: CacheControllerDependencies = {
  api: listenModeApi,
  now: Date.now,
  schedule: (callback) => setTimeout(callback, CACHE_POLL_MS),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function descriptorState(
  descriptor: ListenDocumentDescriptor,
  saved: LoadedListenDocument | null,
  now: number,
): ListenDocumentState {
  const savedMatches = saved?.identity.contentDigest === descriptor.identity.contentDigest;
  const savedAnchor = savedMatches ? saved?.position.anchor : null;
  const positionAnchor = descriptor.sentences.some(({ anchor }) => anchor === savedAnchor)
    ? savedAnchor
    : (descriptor.sentences[0]?.anchor ?? null);
  return {
    identity: descriptor.identity,
    sentences: descriptor.sentences.map(({ anchor }) => ({ anchor })),
    position: {
      anchor: positionAnchor,
      offsetSeconds: positionAnchor === savedAnchor ? (saved?.position.offsetSeconds ?? 0) : 0,
    },
    playbackRate: savedMatches ? (saved?.playbackRate ?? 1) : 1,
    retention: savedMatches ? (saved?.retention ?? '7d') : '7d',
    updatedAt: now,
  };
}

function emptyProjection(
  descriptor: ListenDocumentDescriptor,
  error: string | null = null,
): ListenDocumentCacheProjection {
  return {
    identity: descriptor.identity,
    cachedAnchors: [],
    cacheBytes: 0,
    totalSentences: descriptor.sentences.length,
    active: false,
    error,
  };
}

function projectionFrom(
  descriptor: ListenDocumentDescriptor,
  document: LoadedListenDocument,
): ListenDocumentCacheProjection {
  const knownAnchors = new Set(descriptor.sentences.map(({ anchor }) => anchor));
  const cachedAnchors = document.sentences
    .filter(({ anchor, assetId }) => Boolean(assetId) && knownAnchors.has(anchor))
    .map(({ anchor }) => anchor);
  return {
    identity: descriptor.identity,
    ...(document.synthesisFingerprint ? { synthesisFingerprint: document.synthesisFingerprint } : {}),
    cachedAnchors,
    cacheBytes: document.cache?.totalBytes ?? 0,
    totalSentences: document.cache?.totalSentences ?? descriptor.sentences.length,
    active: document.cacheRun?.active ?? false,
    error: document.cacheRun?.error ?? null,
  };
}

function hasCurrentIdentity(
  descriptor: ListenDocumentDescriptor,
  document: { identity: { projectPath: string; relativePath: string; contentDigest: string } },
): boolean {
  const { identity } = descriptor;
  return (
    document.identity.projectPath === identity.projectPath &&
    document.identity.relativePath === identity.relativePath &&
    document.identity.contentDigest === identity.contentDigest
  );
}

function isCurrentDocument(descriptor: ListenDocumentDescriptor, document: LoadedListenDocument): boolean {
  return hasCurrentIdentity(descriptor, document);
}

function startAnchorFor(descriptor: ListenDocumentDescriptor, saved: LoadedListenDocument | null): string | undefined {
  if (!saved || !isCurrentDocument(descriptor, saved)) return undefined;
  const anchor = saved?.position.anchor;
  return anchor && descriptor.sentences.some((sentence) => sentence.anchor === anchor) ? anchor : undefined;
}

/**
 * Client-side projection and polling only. The authoritative active run remains
 * in the API process, so releasing a Workspace view cannot cancel document work.
 */
export class DocumentCacheController {
  private readonly polls = new Map<string, unknown>();

  constructor(private readonly dependencies: CacheControllerDependencies = defaultDependencies) {}

  async start(descriptor: ListenDocumentDescriptor): Promise<void> {
    try {
      const existing = await this.dependencies.api.load(descriptor.identity);
      const saved = await this.dependencies.api.save(descriptorState(descriptor, existing, this.dependencies.now()));
      const startAnchor = startAnchorFor(descriptor, existing);
      const document = await this.dependencies.api.startCache({
        identity: descriptor.identity,
        sentences: descriptor.sentences.map(({ anchor, text }) => ({ anchor, text })),
        ...(startAnchor ? { startAnchor } : {}),
      });
      this.apply(descriptor, isCurrentDocument(descriptor, document) ? document : saved);
    } catch (error) {
      this.apply(descriptor, null, error instanceof Error ? error.message : '启动全文缓存失败');
      throw error;
    }
  }

  async refresh(descriptor: ListenDocumentDescriptor): Promise<void> {
    try {
      const document = await this.dependencies.api.load(descriptor.identity);
      this.apply(descriptor, document);
    } catch (error) {
      if (this.retainActiveProjection(descriptor)) return;
      this.apply(descriptor, null, error instanceof Error ? error.message : '读取全文缓存状态失败');
    }
  }

  async cancel(descriptor: ListenDocumentDescriptor): Promise<void> {
    this.stopPolling(descriptor);
    try {
      let fingerprint =
        useListenModeStore.getState().cacheByDocument[listenDocumentCacheKey(descriptor.identity)]
          ?.synthesisFingerprint;
      if (!fingerprint) {
        const document = await this.dependencies.api.load(descriptor.identity);
        this.apply(descriptor, document);
        fingerprint = document && isCurrentDocument(descriptor, document) ? document.synthesisFingerprint : undefined;
      }
      if (!fingerprint) {
        return;
      }
      const document = await this.dependencies.api.cancelCache({
        ...descriptor.identity,
        synthesisFingerprint: fingerprint,
      });
      this.apply(descriptor, document);
    } catch (error) {
      this.apply(descriptor, null, error instanceof Error ? error.message : '取消全文缓存失败');
      throw error;
    }
  }

  async clearAudio(descriptor: ListenDocumentDescriptor): Promise<void> {
    this.stopPolling(descriptor);
    try {
      await this.dependencies.api.clearAudio(descriptor.identity);
      this.apply(descriptor, { ...descriptorState(descriptor, null, this.dependencies.now()), sentences: [] });
    } catch (error) {
      this.apply(descriptor, null, error instanceof Error ? error.message : '清理全文缓存失败');
      throw error;
    }
  }

  /**
   * A file switch never cancels the server run. Keep its bounded poll alive while
   * the run is active so an away player continues to project the same progress.
   */
  release(descriptor: ListenDocumentDescriptor): void {
    const projection = useListenModeStore.getState().cacheByDocument[listenDocumentCacheKey(descriptor.identity)];
    if (projection?.active) return;
    this.stopPolling(descriptor);
  }

  private stopPolling(descriptor: ListenDocumentDescriptor): void {
    const key = listenDocumentCacheKey(descriptor.identity);
    const handle = this.polls.get(key);
    if (handle !== undefined) this.dependencies.clear(handle);
    this.polls.delete(key);
  }

  private apply(
    descriptor: ListenDocumentDescriptor,
    document: LoadedListenDocument | null,
    error: string | null = null,
  ): void {
    this.stopPolling(descriptor);
    const projection =
      document && isCurrentDocument(descriptor, document)
        ? projectionFrom(descriptor, document)
        : emptyProjection(descriptor, error);
    const key = listenDocumentCacheKey(descriptor.identity);
    useListenModeStore.setState((state) => ({
      cacheByDocument: { ...state.cacheByDocument, [key]: projection },
      session: syncSessionCache(state.session, descriptor, projection),
    }));
    if (projection.active) this.scheduleRefresh(descriptor);
  }

  private scheduleRefresh(descriptor: ListenDocumentDescriptor): void {
    const key = listenDocumentCacheKey(descriptor.identity);
    const handle = this.dependencies.schedule(() => {
      this.polls.delete(key);
      void this.refresh(descriptor);
    });
    this.polls.set(key, handle);
  }

  private retainActiveProjection(descriptor: ListenDocumentDescriptor): boolean {
    const projection = useListenModeStore.getState().cacheByDocument[listenDocumentCacheKey(descriptor.identity)];
    if (!projection?.active) return false;
    this.scheduleRefresh(descriptor);
    return true;
  }
}

function syncSessionCache(
  session: ListenModeSession | null,
  descriptor: ListenDocumentDescriptor,
  projection: ListenDocumentCacheProjection,
): ListenModeSession | null {
  if (!session || !hasCurrentIdentity(descriptor, session)) return session;
  return {
    ...session,
    cachedAnchors: projection.cachedAnchors,
    cacheBytes: projection.cacheBytes,
  };
}

export const documentCacheController = new DocumentCacheController();
