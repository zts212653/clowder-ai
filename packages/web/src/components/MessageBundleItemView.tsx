import type { RichBlock } from '@/stores/chat-types';
import { HubIcon } from './hub-icons';
import { RichBlocks } from './rich/RichBlocks';

export type BundleAuthor = { kind: 'user'; userId: string } | { kind: 'cat'; catId: string };
export type BundleItem =
  | {
      status: 'available';
      kind: 'message' | 'quote' | 'cli_quote' | 'rich_block';
      messageId: string;
      sourceThreadId: string;
      author: BundleAuthor;
      timestamp: number;
      readableContent: string;
      comment?: string;
      richBlock?: RichBlock;
    }
  | { status: 'tombstone'; messageId: string; reason: 'source_unavailable' | 'source_changed' };

interface MessageBundleItemViewProps {
  item: BundleItem;
  index: number;
  createdBy: string;
  forwarderName: string;
  getCatLabel: (catId: string) => string;
  onJump: (threadId: string, messageId: string) => void;
}

function tombstoneLabel(item: Extract<BundleItem, { status: 'tombstone' }>): string {
  return item.reason === 'source_changed' ? '原文已变更，无法安全显示' : '原消息已删除、撤回或不可见';
}

export function MessageBundleItemView({
  item,
  index,
  createdBy,
  forwarderName,
  getCatLabel,
  onJump,
}: MessageBundleItemViewProps) {
  if (item.status === 'tombstone') {
    return (
      <div
        data-bundle-tombstone={item.reason}
        className="rounded-lg bg-cafe-surface-sunken px-3 py-2 text-sm text-cafe-muted"
      >
        {tombstoneLabel(item)}
      </div>
    );
  }

  const authorLabel =
    item.author.kind === 'cat'
      ? getCatLabel(item.author.catId)
      : item.author.userId === createdBy
        ? forwarderName
        : item.author.userId;
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-cafe-muted">
        <span className="font-semibold text-cafe-secondary">{authorLabel}</span>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-cafe-interactive hover:bg-cafe-surface-sunken"
          onClick={() => onJump(item.sourceThreadId, item.messageId)}
          aria-label={`查看来源消息 ${index + 1}`}
        >
          {new Date(item.timestamp).toLocaleString('zh-CN', {
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
          })}
          <HubIcon name="external-link" className="h-3 w-3 shrink-0" />
        </button>
      </div>
      {item.kind === 'rich_block' && item.richBlock ? (
        <div data-forwarded-rich-block={item.richBlock.id}>
          <RichBlocks blocks={[item.richBlock]} readOnly />
        </div>
      ) : (
        <div className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed text-cafe-primary">
          {item.readableContent}
        </div>
      )}
      {item.comment ? (
        <div className="mt-3 border-l-2 border-cafe pl-3 text-sm">
          <div className="text-xs font-semibold text-cafe-secondary">{forwarderName} 的点评</div>
          <div className="mt-1 whitespace-pre-wrap text-cafe-primary">{item.comment}</div>
        </div>
      ) : null}
    </>
  );
}
