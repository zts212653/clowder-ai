'use client';
import type { ThreadArtifactDTO } from '@cat-cafe/shared';
import { messagePublicationSource } from '@/components/content-review/usePublishedContent';
import { MessagePublicationLandingResolver } from './MessagePublicationLandingResolver';
import type { WorkspaceSurfaceDescriptor } from './workbench-contract';

export function ArtifactPublicationSurface({
  artifact,
  threadId,
  onBack,
  surface,
  onResolved,
}: {
  surface: WorkspaceSurfaceDescriptor;
  onResolved: (surface: WorkspaceSurfaceDescriptor) => void;
  artifact: ThreadArtifactDTO;
  threadId: string;
  onBack: () => void;
}) {
  const { sourceMessageId, publicationItem, createdAt, url } = artifact;
  const source =
    sourceMessageId && publicationItem && url
      ? messagePublicationSource(
          { threadId, messageId: sourceMessageId, messageRevision: String(createdAt) },
          publicationItem,
          url,
        )
      : null;
  return source ? (
    <MessagePublicationLandingResolver
      key={JSON.stringify(source)}
      source={source}
      surface={surface}
      onResolved={onResolved}
      onBack={onBack}
    />
  ) : (
    <section className="p-4">
      <button type="button" onClick={onBack}>
        返回来源
      </button>
      <p role="alert">原发布消息没有可核验的内容坐标，请回到来源核对。</p>
    </section>
  );
}
