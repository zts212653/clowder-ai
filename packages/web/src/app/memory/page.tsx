import { MemoryEntry } from '@/components/memory/page/MemoryEntry';
import { readProfileSourceTarget } from '@/components/memory/page/profile-source-target';

export default function MemoryPage({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  const from = typeof searchParams.from === 'string' ? searchParams.from : null;
  const requested = searchParams.tab;
  const tab = requested === 'brakes' || requested === 'library' || requested === 'recall' ? requested : 'all';
  return <MemoryEntry tab={tab} from={from} profileSource={readProfileSourceTarget(searchParams)} />;
}
