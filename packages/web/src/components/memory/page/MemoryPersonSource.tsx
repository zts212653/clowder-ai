import { useRouter } from 'next/navigation';
import { handleTeleportEvent } from '@/hooks/useTeleport';
import { scrollToMessage } from '@/utils/scrollToMessage';
import { isPersonSources, type PersonSources } from './people-types';
import { useMemoryRead } from './use-memory-read';

export function MemoryPersonSource({
  personId,
  kind = 'person',
  itemId,
}: {
  personId: string;
  kind?: 'person' | 'claim' | 'relationship' | 'event';
  itemId?: string;
}) {
  const source = useMemoryRead<PersonSources>(
    `/api/memory/people/${encodeURIComponent(personId)}/source?kind=${kind}${itemId ? `&itemId=${encodeURIComponent(itemId)}` : ''}`,
    isPersonSources,
  );
  const router = useRouter();
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
          <p key={item.label}>{item.label}</p>
        ) : (
          <button
            key={`${item.threadId}:${item.messageId}`}
            type="button"
            className="block text-cafe-accent underline"
            onClick={() =>
              handleTeleportEvent({ threadId: item.threadId, messageId: item.messageId }, null, {
                pushThreadRoute: (id) => router.push(`/thread/${encodeURIComponent(id)}`),
                scrollToMessage,
              })
            }
          >
            查看原消息 · {item.title || '来源对话'}
          </button>
        ),
      )}
    </div>
  );
}
