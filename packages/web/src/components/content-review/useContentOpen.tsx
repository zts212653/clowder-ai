'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { readWorkCardDescription, type WorkCardDescription } from '@/components/artifacts/useWorkCardDescription';
import { createArtifactSurface, createFileSurface } from '@/components/workbench/real-surface-adapters';
import { useChatStore } from '@/stores/chatStore';
import { API_URL } from '@/utils/api-client';
import { captureChatReadingBeforeLayoutChange } from '@/utils/chat-layout-change';
import { createCollectiveDocumentSurface } from '../workbench/collective-document-surface';
import { useF307ExperienceWorkbenchStore } from '../workbench/experience-workbench-store';
import { useArtworkLightboxScope } from './ArtworkLightboxScope';
import { type ContentOpenSource, contentOpenFacts, contentSourcePreview } from './content-open-source';
import { contentFileUrl, workspaceFileSourceFromUrl } from './file-source';
import { resolvePublishedFile } from './published-file-source';
import { useChatArtworkEntry, workspaceArtworkEntry } from './useChatArtworkEntry';
import { type MediaOpenInput, useContentMediaOpen } from './useContentMediaOpen';
import { messagePublicationSource, type PublishedMessageCoordinate } from './usePublishedContent';

/** Source resolution and opening policy are shared by all entries; existing owners keep authority and state. */
export function useContentOpen(publication?: PublishedMessageCoordinate, sourceScopeKey?: string) {
  const artwork = useChatArtworkEntry(publication);
  const scope = useArtworkLightboxScope();
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const hostThreadId = useChatStore((s) => s.currentThreadId);
  const [navigating, setNavigating] = useState(false);
  const [openingError, setOpeningError] = useState<string | null>(null);
  const [description, setDescription] = useState<WorkCardDescription | null>(null);
  const navigation = useRef(0);
  const resolution = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      navigation.current++;
      resolution.current?.abort();
    },
    [hostThreadId, sourceScopeKey],
  );
  const media = useContentMediaOpen({
    artwork,
    scopeRef,
    hostThreadId,
    publication,
    sourceScopeKey,
    navigation,
    setNavigating,
    openContent: (source, mode) => openContent(source, mode),
  });
  const show = media.show;
  function galleryFor(source: ContentOpenSource, mode: 'lightbox' | 'work-mode') {
    const group = source.gallery;
    if (!group || group.items.length < 2) return undefined;
    return {
      items: group.items.map(contentSourcePreview),
      index: group.index,
      onSelect: (index: number) => {
        if (index >= 0 && index < group.items.length && index !== group.index)
          void openContent({ ...group.items[index], gallery: { ...group, index } }, mode);
      },
    };
  }
  async function openContent(source: ContentOpenSource, mode: 'lightbox' | 'work-mode' = 'lightbox'): Promise<boolean> {
    setOpeningError(null);
    setNavigating(true);
    resolution.current?.abort();
    const abort = new AbortController();
    resolution.current = abort;
    const host = useChatStore.getState().currentThreadId;
    const ticket = ++navigation.current;
    const generation = scopeRef.current?.getGeneration();
    const valid = () =>
      navigation.current === ticket &&
      useChatStore.getState().currentThreadId === host &&
      scopeRef.current?.getGeneration() === generation;
    try {
      if (source.kind === 'collective') {
        captureChatReadingBeforeLayoutChange();
        const store = useF307ExperienceWorkbenchStore.getState();
        if (!store.hydrated) store.hydrate();
        useF307ExperienceWorkbenchStore.getState().dispatch({
          type: 'open-surface',
          surface: createCollectiveDocumentSurface({ target: source.target, hostKey: source.hostKey }),
          entitlement: { kind: 'user', reason: 'open-from-chat' },
          visitThreadId: host,
        });
        scopeRef.current?.close();
        return true;
      }
      if (source.kind === 'message-file') {
        const mediaUrl = contentFileUrl(source.url);
        if (!mediaUrl) throw new Error('这份文件的链接格式不可打开。');
        const registered = await source.resolveRegistered?.();
        if (!valid()) return false;
        const reference = registered?.work ?? source.reference;
        if (reference)
          return openContent(
            {
              kind: 'work',
              reference,
              title: registered?.name ?? source.name,
              origin: source.origin,
              current: source.current,
              gallery: source.gallery,
            },
            mode,
          );
        const facts = contentOpenFacts(source);
        if (facts.floating)
          return show(
            {
              url: mediaUrl,
              title: source.name,
              alt: source.name,
              mediaType: facts.kind === 'video' ? 'video' : 'image',
              entry: artwork.source(source.url, source.item, source.coordinate),
              item: source.item,
              gallery: galleryFor(source, mode),
              navigationOrigin: source.origin,
            },
            mode,
          );
        const workspace = workspaceFileSourceFromUrl(source.url);
        if (workspace)
          return openContent(
            {
              kind: 'workspace',
              target: { worktreeId: workspace.worktreeId, path: workspace.path, navigationOrigin: source.origin },
              origin: source.origin,
            },
            mode,
          );
        const original = await resolvePublishedFile(
          source.url,
          source.coordinate.threadId,
          source.sourceMessageIds ?? [source.coordinate.messageId],
          abort.signal,
          source.item,
        );
        if (!valid()) return false;
        return openContent(
          {
            kind: 'artifact',
            threadId: source.coordinate.threadId,
            artifact: original,
            origin: source.origin,
            gallery: source.gallery,
          },
          mode,
        );
      }
      if (source.kind === 'work') {
        if (
          source.expectedSurfaceKey !== undefined &&
          scopeRef.current?.work?.surface?.ownerStateRef.key !== source.expectedSurfaceKey
        )
          return false;
        const result = await readWorkCardDescription(source.reference, source.current ?? false);
        if (!valid()) return false;
        setDescription(result);
        const target = {
          kind: 'publication' as const,
          contentRef: source.reference.contentRef,
          ownerRevision: result.asset.ownerRevision,
          title: source.title,
          ...(source.origin ? { navigationOrigin: source.origin } : {}),
        };
        const url = `${API_URL}/api/content-publications/${encodeURIComponent(target.contentRef)}/media/${target.ownerRevision}`;
        return show(
          {
            url,
            title: source.title,
            alt: source.title,
            mediaType: result.asset.mediaType.startsWith('video/') ? 'video' : 'image',
            entry: null,
            gallery: galleryFor(source, mode),
            admitted: { status: 'opened', target },
            navigationOrigin: source.origin,
          },
          mode,
        );
      }
      if (source.kind === 'artifact' && source.artifact.work?.contentRef.startsWith('work:'))
        return openContent(
          {
            kind: 'work',
            reference: source.artifact.work,
            title: source.artifact.name,
            origin: source.origin,
            gallery: source.gallery,
          },
          mode,
        );
      const facts = contentOpenFacts(source);
      if (source.kind === 'artifact' && source.artifact.url) {
        const candidate = workspaceFileSourceFromUrl(source.artifact.url);
        if (candidate)
          return openContent(
            {
              kind: 'workspace',
              target: { worktreeId: candidate.worktreeId, path: candidate.path, navigationOrigin: source.origin },
              attach: source.attach,
              origin: source.origin,
              gallery: source.gallery,
            },
            mode,
          );
        if (!contentFileUrl(source.artifact.url)) throw new Error('这份文件的链接格式不可打开。');
      }
      if (!facts.floating) {
        captureChatReadingBeforeLayoutChange();
        if (source.kind === 'artifact') {
          if (source.attach)
            source.attach(
              createArtifactSurface({
                threadId: source.threadId,
                artifact: source.artifact,
                navigationOrigin: source.origin,
              }),
            );
          else {
            const artifact =
              source.threadId !== host ? { ...source.artifact, threadId: source.threadId } : source.artifact;
            useChatStore.getState().openPublishedArtifact(host, artifact, source.origin);
          }
        } else {
          if (source.attach) source.attach(createFileSurface(source.target));
          else useChatStore.getState().openWorkspacePath(host, { kind: 'file', ...source.target });
        }
        scopeRef.current?.close();
        return true;
      }
      const locator =
        source.kind === 'workspace'
          ? { kind: 'workspace' as const, worktreeId: source.target.worktreeId, path: source.target.path }
          : workspaceArtworkEntry(source.artifact.url ?? '');
      const artifact = source.kind === 'artifact' ? source.artifact : undefined;
      const entry =
        locator ??
        (artifact?.sourceMessageId && artifact.publicationItem && artifact.url
          ? messagePublicationSource(
              {
                threadId: source.kind === 'artifact' ? source.threadId : host,
                messageId: artifact.sourceMessageId,
                messageRevision: String(artifact.createdAt),
              },
              artifact.publicationItem,
              artifact.url,
            )
          : null);
      const url =
        source.kind === 'workspace'
          ? `${API_URL}/api/workspace/file/raw?${new URLSearchParams({ worktreeId: source.target.worktreeId, path: source.target.path })}`
          : source.artifact.url;
      if (!url) return false;
      return show(
        {
          url: url.startsWith('/') ? API_URL + url : url,
          title: facts.name,
          alt: facts.name,
          mediaType: facts.kind === 'video' ? 'video' : 'image',
          entry,
          workspaceTarget: source.kind === 'workspace' ? source.target : undefined,
          gallery: galleryFor(source, mode),
          navigationOrigin: source.origin,
        },
        mode,
      );
    } catch (error) {
      if (valid()) setOpeningError(error instanceof Error ? error.message : '原内容暂时无法打开，请重试。');
      return false;
    } finally {
      if (navigation.current === ticket) setNavigating(false);
    }
  }
  const latest = useRef(openContent);
  latest.current = openContent;
  const open = useCallback(
    (source: ContentOpenSource, mode: 'lightbox' | 'work-mode' = 'lightbox') => latest.current(source, mode),
    [],
  );
  return {
    ...artwork,
    description,
    openContent: open,
    error: openingError ?? artwork.error,
    busy: navigating,
    enlarge: (input: MediaOpenInput) => show(input, 'lightbox'),
    openWorkMode: (input: MediaOpenInput) => show(input, 'work-mode'),
    lightbox: media.lightbox,
    invalidate: (reason: string) => {
      resolution.current?.abort();
      media.cancel();
      setOpeningError(reason);
    },
  };
}
