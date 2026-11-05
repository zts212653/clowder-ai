import { type AssetCanonItem, type AssetContextAttachment, ContextAttachmentsSchema } from '@cat-cafe/shared';
import { composerAttachments, queuedServerAckBlocks } from '@/components/composer-queue';
import { useChatStore } from '@/stores/chatStore';

export function addAssetToChat(threadId: string, item: AssetCanonItem, workTitle?: string): string | null {
  if (!item.work) return '这件素材尚未关联到这版片子。';
  if (queuedServerAckBlocks()) return '输入框正在恢复，请稍后再添加素材。';
  const current = composerAttachments(threadId);
  const id = `asset-${crypto.randomUUID()}`;
  if (
    current.some(
      (a) =>
        a.kind === 'asset' &&
        a.indexedVersionRef === item.record.indexedVersionRef &&
        a.work.reference.contentRef === item.work!.reference.contentRef &&
        a.work.reference.ownerRevision === item.work!.reference.ownerRevision &&
        a.work.metadataRevision === item.work!.metadataRevision &&
        a.work.assetId === item.work!.assetId,
    )
  )
    return null;
  const attachment: AssetContextAttachment = {
    v: 1,
    id,
    kind: 'asset',
    ...(workTitle ? { workTitle: workTitle.slice(0, 300) } : {}),
    name: item.record.name,
    indexedVersionRef: item.record.indexedVersionRef,
    work: item.work,
    mediaType: item.record.version.mediaType,
  };
  if (!ContextAttachmentsSchema.safeParse([...current, attachment]).success)
    return '输入框里的引用已满，请先发送或移除几个。';
  const queued = useChatStore.getState().pendingChatInsert;
  const base = queued?.threadId === threadId ? queued : { threadId, text: '' };
  useChatStore.getState().setPendingChatInsert({
    ...base,
    preserveSelection: true,
    contextAttachments: [...(base.contextAttachments ?? []), attachment],
  });
  return null;
}
