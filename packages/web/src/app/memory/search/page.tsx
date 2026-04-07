import { MemoryHub } from '@/components/memory/MemoryHub';

export default function MemorySearchPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const q = typeof searchParams.q === 'string' ? searchParams.q : '';
  return <MemoryHub activeTab="search" initialQuery={q} />;
}
