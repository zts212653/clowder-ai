import { CatAvatar } from '@/components/CatAvatar';
import { useCatData } from '@/hooks/useCatData';
import { resolveCatDisplayName } from '@/lib/cat-display-name';

export function TrajectoryCatIdentity({ catId }: { catId: string }) {
  const { getCatById } = useCatData({ fetch: false });
  return (
    <span className="inline-flex min-w-0 items-center gap-2 text-xs font-semibold text-cafe">
      <CatAvatar catId={catId} size={20} />
      <span className="min-w-0 break-words">{resolveCatDisplayName(catId, getCatById)}</span>
    </span>
  );
}
