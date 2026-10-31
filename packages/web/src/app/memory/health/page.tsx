import { MemoryHub } from '@/components/memory/MemoryHub';

export default function MemoryHealthPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const from = typeof searchParams.from === 'string' ? searchParams.from : null;
  return <MemoryHub activeTab="health" initialReferrerThread={from} />;
}
