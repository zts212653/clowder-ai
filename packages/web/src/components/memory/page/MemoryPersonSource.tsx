import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { ExternalLinkIcon } from '@/components/HubConfigIcons';
import { handleTeleportEvent } from '@/hooks/useTeleport';
import { scrollToMessage } from '@/utils/scrollToMessage';
import { isPersonSources, type PersonSources } from './people-types';
import { formatMemoryDate, useMemoryRead } from './use-memory-read';

export function MemoryPersonSource({
  personId,
  kind = 'person',
  itemId,
  onReadState,
}: {
  personId: string;
  kind?: 'person' | 'claim' | 'relationship' | 'event';
  itemId?: string;
  onReadState?: (state: 'loading' | 'ready' | 'unavailable') => void;
}) {
  const source = useMemoryRead<PersonSources>(
    `/api/memory/people/${encodeURIComponent(personId)}/source?kind=${kind}${itemId ? `&itemId=${encodeURIComponent(itemId)}` : ''}`,
    isPersonSources,
  );
  const router = useRouter();
  const state = source.loading ? 'loading' : !source.error && source.data?.status === 'ready' ? 'ready' : 'unavailable';
  useEffect(() => {
    onReadState?.(state);
  }, [state, onReadState]);
  if (source.loading) return <p className="text-xs text-cafe-muted">正在读取来源…</p>;
  if (source.error || source.data?.status !== 'ready')
    return (
      <p className="text-xs text-cafe-muted">
        来源暂时读不到{' '}
        <button type="button" onClick={source.retry} className="underline">
          重读来源
        </button>
      </p>
    );
  return (
    <div className="space-y-1 text-xs text-cafe-muted">
      {source.data.sources.map((item) =>
        item.kind === 'owner_action' ? (
          <p key={item.label}>
            {item.label} · {formatMemoryDate(item.occurredAt)}
          </p>
        ) : (
          <div key={`${item.threadId}:${item.messageId}`} className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>
              原消息 · {item.title || '来源对话'} · {item.speaker || '说话人没有记录下来'} ·{' '}
              {formatMemoryDate(item.occurredAt ?? null)}
            </span>
            <button
              type="button"
              className="inline-flex items-center gap-1 text-cafe-accent underline"
              onClick={() =>
                handleTeleportEvent({ threadId: item.threadId, messageId: item.messageId }, null, {
                  pushThreadRoute: (id) => router.push(`/thread/${encodeURIComponent(id)}`),
                  scrollToMessage,
                })
              }
            >
              查看原消息
              <ExternalLinkIcon />
            </button>
          </div>
        ),
      )}
    </div>
  );
}
