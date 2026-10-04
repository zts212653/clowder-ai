import { useState } from 'react';
import { CollectiveIcon } from './CollectiveIcon.js';

export function publicAvatarUrl(value?: string): string | undefined {
  if (!value) return undefined;
  if (/^data:image\/webp;base64,[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length <= 1_200) return value;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function MemberAvatar({
  name,
  kind,
  avatarUrl,
  compact = false,
}: {
  readonly name: string;
  readonly kind: 'human' | 'agent';
  readonly avatarUrl?: string;
  readonly compact?: boolean;
}) {
  const [failedUrl, setFailedUrl] = useState<string>();
  const url = publicAvatarUrl(avatarUrl);
  return (
    <span className={compact ? 'avatar avatar-compact' : 'avatar'} data-actor-kind={kind}>
      {url && failedUrl !== url ? (
        <img src={url} alt="" referrerPolicy="no-referrer" onError={() => setFailedUrl(url)} />
      ) : kind === 'agent' ? (
        <CollectiveIcon kind="cat" />
      ) : (
        name.slice(0, 1)
      )}
    </span>
  );
}
