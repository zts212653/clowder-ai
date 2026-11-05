import type { MessageSelectionProjectedItem as BundleItem } from '@cat-cafe/shared';
import { catColorVar } from '@/lib/cat-slug';
import { CatAvatar } from '../CatAvatar';
import { useShellCopy } from '../shell/shell-copy';
import { messageReadingCopy } from './message-reading-copy';

/** A compact read of the currently authorized item, never a stored source snapshot. */
export function MessageBundlePreviewItem({ item, authorName }: { item: BundleItem; authorName?: string }) {
  const t = useShellCopy(messageReadingCopy);
  if (item.status === 'tombstone')
    return (
      <div
        data-bundle-preview-item={item.messageId}
        data-bundle-tombstone={item.reason}
        className="py-2 text-compact text-cafe-muted"
      >
        {item.reason === 'source_changed' ? t.sourceChanged : t.messageUnavailable}
      </div>
    );
  return (
    <div data-bundle-preview-item={item.messageId} className="min-w-0 py-2">
      <div className="flex min-w-0 items-center gap-2 text-xs">
        <span
          className="inline-flex min-w-0 items-center gap-1.5 rounded-t-md px-1.5 py-0.5 font-semibold"
          style={
            item.from.kind === 'agent'
              ? {
                  background: `linear-gradient(${catColorVar(item.from.catId, 'surface')}, transparent)`,
                  color: catColorVar(item.from.catId, 'text'),
                }
              : item.from.kind === 'user'
                ? { color: 'var(--color-cocreator-text)' }
                : { color: 'var(--color-cafe-muted)' }
          }
        >
          {item.from.kind === 'agent' && <CatAvatar catId={item.from.catId} size={16} ring="none" />}
          <span className="truncate">{authorName}</span>
        </span>
        <time className="shrink-0 text-cafe-muted" dateTime={new Date(item.timestamp).toISOString()}>
          {new Date(item.timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
        </time>
      </div>
      <div className="mt-1 line-clamp-2 whitespace-pre-wrap break-words text-compact leading-relaxed text-cafe-primary">
        {item.readableContent}
      </div>
    </div>
  );
}
