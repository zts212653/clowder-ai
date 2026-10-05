import { MemoryPagePreview, type MemoryPageTab } from '@/components/memory/page/MemoryPagePreview';

export default function MemoryPreviewPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const requested = searchParams.tab;
  const tab: MemoryPageTab =
    requested === 'brakes' || requested === 'library' || requested === 'recall' ? requested : 'all';
  const shell = searchParams.shell === 'v2' || searchParams.shell === 'classic' ? searchParams.shell : undefined;
  return <MemoryPagePreview tab={tab} shell={shell} />;
}
