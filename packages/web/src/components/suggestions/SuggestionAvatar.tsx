'use client';
import { useCatData } from '@/hooks/useCatData';
import { resolveAvatarUrl } from '@/lib/avatar-url';

const EyeIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.4"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6S2 12 2 12Z" />
    <circle cx="12" cy="12" r="2.6" fill="currentColor" stroke="none" />
  </svg>
);

/** Who is speaking on the row: the cat's avatar; the watcher carries the eye badge (F335 4a 标识). */
export function SuggestionAvatar({ catId, watcher }: { catId?: string; watcher: boolean }) {
  const { getCatById } = useCatData();
  const src = resolveAvatarUrl((catId ? getCatById(catId)?.avatar : undefined) || '/avatars/default.png');
  return (
    <span className="w-av" data-watcher={watcher ? 'true' : undefined}>
      {/* biome-ignore lint/performance/noImgElement: 16px member avatar, same source as CatAvatar */}
      <img src={src} width={16} height={16} alt="" />
      {watcher ? (
        <span className="eye">
          <EyeIcon />
        </span>
      ) : null}
    </span>
  );
}
