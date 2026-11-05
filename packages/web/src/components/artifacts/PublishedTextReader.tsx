import {
  type MessageQuoteSource,
  MessageQuoteSourceSchema,
  projectFileContent,
  type ThreadArtifactDTO,
} from '@cat-cafe/shared';
import { type ReactNode, useEffect, useState } from 'react';
import { API_URL } from '@/utils/api-client';
import { contentFileInfo, type FileActionSource, fileSourceIdentity } from '../content-review/file-action-client';
import { WorkspaceFileViewer } from '../workspace/WorkspaceFileViewer';
import { resolveAssetUrl } from './artifact-view';

/** An exact file leaf of the already authorized message; this is a quotation, not a writable content owner. */
export function publishedTextQuoteSource(
  artifact: ThreadArtifactDTO,
  threadId: string | undefined,
  displayDigest: string | undefined,
): MessageQuoteSource | undefined {
  if (
    !threadId ||
    !artifact.sourceMessageId ||
    !artifact.publicationItem ||
    !artifact.url ||
    !/^\/uploads\/[^/?#\u0000]+$/.test(artifact.url) ||
    !displayDigest
  )
    return undefined;
  const source = MessageQuoteSourceSchema.safeParse({
    kind: 'message',
    threadId,
    messageId: artifact.sourceMessageId,
    ...(artifact.catId ? { senderCatId: artifact.catId } : {}),
    artifactFile: {
      item: artifact.publicationItem,
      url: artifact.url,
      fileName: artifact.name,
      messageRevision: String(artifact.createdAt),
      displayDigest: `sha256:${displayDigest}`,
    },
  });
  return source.success ? source.data : undefined;
}

/** Adapt a fetched publication into the original reader, with no workspace locator or write callbacks. */
export function PublishedTextReader({
  artifact,
  content,
  sourceThreadId,
  onBack,
  reviewAction,
  source,
  binary = false,
  truncated = false,
  byteLength,
  mime,
}: {
  artifact: ThreadArtifactDTO;
  content: string;
  sourceThreadId?: string;
  onBack: () => void;
  reviewAction?: ReactNode;
  source?: FileActionSource;
  binary?: boolean;
  truncated?: boolean;
  byteLength?: number;
  mime?: string;
}) {
  const fileSource = source ?? { kind: 'url' as const, url: resolveAssetUrl(artifact.url, API_URL) ?? '' };
  const metadataKey = fileSourceIdentity(fileSource);
  const [metadata, setMetadata] = useState<{ key: string; byteLength: number | undefined }>();
  useEffect(() => {
    if (!binary) return;
    let current = true;
    void contentFileInfo(fileSource).then(
      (info) => {
        if (current) setMetadata({ key: metadataKey, byteLength: info.byteLength });
      },
      () => {
        if (current) setMetadata({ key: metadataKey, byteLength: undefined });
      },
    );
    return () => {
      current = false;
    };
  }, [binary, metadataKey]);
  const [snapshot, setSnapshot] = useState<{ content: string; digest: string }>();
  useEffect(() => {
    let current = true;
    if (binary || truncated || !globalThis.crypto?.subtle) return;
    void globalThis.crypto.subtle
      .digest('SHA-256', new TextEncoder().encode(content))
      .then((buffer) => {
        if (current)
          setSnapshot({
            content,
            digest: Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join(''),
          });
      })
      .catch(() => {
        /* Reading remains available; unverifiable bytes cannot produce a source-bound quote. */
      });
    return () => {
      current = false;
    };
  }, [content, binary, truncated]);
  const digest = !truncated && snapshot?.content === content ? snapshot.digest : undefined;
  return (
    <WorkspaceFileViewer
      file={{
        path: source?.kind === 'workspace' ? source.path : artifact.name,
        content,
        sha256: digest ?? '',
        size: binary
          ? metadata?.key === metadataKey
            ? metadata.byteLength
            : undefined
          : (byteLength ?? new TextEncoder().encode(content).length),
        mime: mime ?? projectFileContent(artifact).mime,
        binary,
        truncated,
      }}
      source={fileSource}
      quoteSource={publishedTextQuoteSource(artifact, sourceThreadId, digest)}
      readOnlyReason={
        fileSource.kind === 'workspace'
          ? '此视图只读；原文件保留在工作区'
          : '发到聊天时保存的副本；修改副本不会修改原稿'
      }
      listenReturn={
        sourceThreadId && (!source || source.kind === 'url') ? { threadId: sourceThreadId, artifact } : undefined
      }
      onBack={onBack}
      reviewAction={reviewAction}
    />
  );
}
