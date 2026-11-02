import { MemoryEntry } from '@/components/memory/page/MemoryEntry';
import { readProfileSourceTarget } from '@/components/memory/page/profile-source-target';

export default function MemoryPage({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  const from = typeof searchParams.from === 'string' ? searchParams.from : null;
  const requested = searchParams.tab;
  const tab = requested === 'brakes' || requested === 'library' || requested === 'recall' ? requested : 'all';
  const query = typeof searchParams.q === 'string' ? searchParams.q : undefined;
  const findSessionId = typeof searchParams.findSession === 'string' ? searchParams.findSession : undefined;
  return (
    <MemoryEntry
      tab={tab}
      from={from}
      profileSource={readProfileSourceTarget(searchParams)}
      initialQuery={query}
      findSessionId={findSessionId}
    />
  );
}
