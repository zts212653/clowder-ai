import type { ContextAttachment, QuoteContextAttachment } from '@cat-cafe/shared';
import { type CatData, useCatData } from '@/hooks/useCatData';
import { useCoCreatorConfig } from '@/hooks/useCoCreatorConfig';
import { formatCatDisplayName } from '@/lib/cat-display-name';
import type { ChatMessage } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { artworkTitle } from './content-review/artwork-title';
import { replyBodyCopy } from './reply-body.shell-copy';
import { useShellCopy } from './shell/shell-copy';

function quoteSourceTitle(source: QuoteContextAttachment['source']): string {
  switch (source.kind) {
    case 'workspace_file':
      return source.path;
    case 'cli_output':
      return 'CLI Output';
    case 'collective_message':
      return `#${source.channelId}`;
    case 'message':
      return source.artifactFile?.fileName ?? 'Message quote';
  }
}

function originalPresentation(attachment: ContextAttachment): { title: string; detail: string } {
  switch (attachment.kind) {
    case 'asset':
      return { title: attachment.name, detail: `素材 · 第 ${attachment.work.reference.ownerRevision} 版` };
    case 'thread':
      return { title: attachment.title, detail: attachment.threadId };
    case 'project-screening':
      return {
        title: attachment.title,
        detail: `审片 · 输入 v${attachment.input.ownerRevision} · ${attachment.selections.length} 处待讨论`,
      };
    case 'media':
      return {
        title: attachment.title,
        detail: `${attachment.mediaType === 'video/mp4' ? '视频' : '图片'} · ${attachment.selections.length ? `${attachment.selections.length}处选区` : '整件作品'}`,
      };
    case 'workspace_file':
      return {
        title: attachment.path.split('/').pop() || attachment.path,
        detail: [attachment.path, attachment.branch ?? attachment.worktreeId].filter(Boolean).join(' · '),
      };
    case 'quote':
      return {
        title: quoteSourceTitle(attachment.source),
        detail: attachment.text,
      };
  }
}

const KIND_LABELS: Record<ContextAttachment['kind'], string> = {
  asset: '素材',
  thread: 'THREAD',
  workspace_file: 'FILE',
  quote: 'QUOTE',
  media: 'MEDIA',
  'project-screening': '审片',
};

function quoteTitle(
  source: Exclude<QuoteContextAttachment['source'], { kind: 'workspace_file' }>,
  loadedSource: ChatMessage | undefined,
  getCatById: (id: string) => CatData | undefined,
  humanName: string,
  t: typeof replyBodyCopy.zh,
): string {
  if (source.kind === 'collective_message') return `#${source.channelId}`;
  if (source.kind === 'message' && source.artifactFile) return source.artifactFile.fileName;
  if (source.kind === 'message' && source.displayLabel) return source.displayLabel;
  // Legacy CLI references do not prove which rendered leaf was quoted.
  if (source.kind === 'cli_output' && source.segmentId !== 'stdout') return t.executionRecord;
  if (loadedSource?.type === 'user') return t.replyBy(humanName);
  const catId = loadedSource ? loadedSource.catId : source.kind === 'message' ? source.senderCatId : undefined;
  const cat = catId ? getCatById(catId) : undefined;
  return cat ? t.replyBy(formatCatDisplayName(cat)) : t.reply;
}

/** One title for the visible card and its accessible controls; no message fetches. */
export function useContextAttachmentPresentation(attachment: ContextAttachment, isV2: boolean) {
  const t = useShellCopy(replyBodyCopy);
  const { getCatById } = useCatData({ fetch: false });
  const coCreator = useCoCreatorConfig();
  const source =
    attachment.kind === 'quote' && attachment.source.kind !== 'workspace_file' ? attachment.source : undefined;
  const loadedSource = useChatStore((state) =>
    isV2 && source && source.kind !== 'collective_message' && state.currentThreadId === source.threadId
      ? state.messages.find((message) => message.id === source.messageId)
      : undefined,
  );
  const original = originalPresentation(attachment);
  const title = isV2 && source ? quoteTitle(source, loadedSource, getCatById, coCreator.name, t) : original.title;
  return {
    title: isV2 && attachment.kind === 'media' ? artworkTitle(title, t.media) : title,
    detail: original.detail,
    kindLabel:
      isV2 && attachment.kind === 'quote'
        ? t.quote
        : isV2 && attachment.kind === 'media'
          ? t.media
          : KIND_LABELS[attachment.kind],
    commentLabel: isV2 ? t.comment : 'Comment',
    removeLabel: isV2 ? t.remove(title) : `移除上下文 ${original.title}`,
  };
}
