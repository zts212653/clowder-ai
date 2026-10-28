import {
  type MessageQuoteSource,
  MessageQuoteSourceSchema,
  projectFileContent,
  type ThreadArtifactDTO,
} from '@cat-cafe/shared';
import { type ReactNode, useEffect, useState } from 'react';
import { API_URL } from '@/utils/api-client';
import type { FileActionSource } from '../content-review/file-action-client';
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
  mime,
}: {
  artifact: ThreadArtifactDTO;
  content: string;
  sourceThreadId?: string;
  onBack: () => void;
  reviewAction?: ReactNode;
  source?: FileActionSource;
  binary?: boolean;
  mime?: string;
}) {
  const [snapshot, setSnapshot] = useState<{ content: string; digest: string }>();
  useEffect(() => {
    let current = true;
    if (binary || !globalThis.crypto?.subtle) return;
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
  }, [content, binary]);
  const digest = snapshot?.content === content ? snapshot.digest : undefined;
  return (
    <WorkspaceFileViewer
      file={{
        path: source?.kind === 'workspace' ? source.path : artifact.name,
        content,
        sha256: digest ?? '',
        size: new TextEncoder().encode(content).length,
        mime: mime ?? projectFileContent(artifact).mime,
        binary,
        truncated: false,
      }}
      source={source ?? { kind: 'url', url: resolveAssetUrl(artifact.url, API_URL) ?? '' }}
      quoteSource={publishedTextQuoteSource(artifact, sourceThreadId, digest)}
      readOnlyReason="发到聊天时保存的副本；修改副本不会修改原稿"
      listenReturn={
        sourceThreadId && (!source || source.kind === 'url') ? { threadId: sourceThreadId, artifact } : undefined
      }
      onBack={onBack}
      reviewAction={reviewAction}
    />
  );
}
