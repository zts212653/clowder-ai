import type { SenderMeta } from '@/lib/resolve-sender';
import { AvatarImageWithFallback } from './AvatarImageWithFallback';
import { ConnectorIcon } from './icons/ConnectorIcon';

export function SenderAvatar({ sender, className = 'h-5 w-5' }: { sender: SenderMeta; className?: string }) {
  return (
    <span className={`${className} inline-flex shrink-0 items-center justify-center`} aria-hidden="true">
      {sender.icon || sender.fallbackIcon ? (
        <ConnectorIcon iconSpec={sender.icon} fallbackIcon={sender.fallbackIcon} className={className} />
      ) : (
        <AvatarImageWithFallback src={sender.avatar} alt="" className={`${className} rounded-full object-cover`} />
      )}
    </span>
  );
}
