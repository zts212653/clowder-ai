import type { SenderMeta } from '@/lib/resolve-sender';
import { AvatarImageWithFallback } from './AvatarImageWithFallback';
import { ConnectorIcon } from './icons/ConnectorIcon';

/** A member's avatar body; callers supply identity and optional interaction, never another frame. */
export function SenderAvatar({
  sender,
  className = 'h-5 w-5',
  presentation = 'inline',
  shape = 'round',
  onClick,
  streaming = false,
}: {
  sender: SenderMeta;
  className?: string;
  presentation?: 'inline' | 'message' | 'nameplate';
  shape?: 'round' | 'rounded-square';
  onClick?: () => void;
  streaming?: boolean;
}) {
  const message = presentation === 'message';
  const fullSize = presentation !== 'inline';
  const image =
    sender.avatar ??
    (sender.icon && 'src' in sender.icon ? sender.icon.src : undefined) ??
    (!sender.icon && (sender.fallbackIcon?.startsWith('/') || sender.fallbackIcon?.startsWith('http'))
      ? sender.fallbackIcon
      : undefined);
  const Frame = onClick ? 'button' : 'span';
  return (
    <Frame
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      aria-label={onClick ? `编辑 ${sender.label}` : undefined}
      aria-hidden={onClick ? undefined : true}
      data-sender-avatar={presentation}
      data-sender-avatar-shape={shape}
      className={`${fullSize ? `relative w-8 h-8 ${shape === 'rounded-square' ? 'rounded-lg' : 'rounded-full'} overflow-hidden` : className} inline-flex shrink-0 items-center justify-center ${streaming ? 'animate-pulse' : ''} ${onClick ? 'cursor-pointer hover:opacity-80 transition-opacity' : ''}`}
      style={
        fullSize
          ? {
              backgroundColor: presentation === 'nameplate' ? 'var(--shell-work)' : 'var(--cafe-surface)',
              color: sender.color,
            }
          : undefined
      }
    >
      {sender.initial && !image && !sender.icon && !sender.fallbackIcon ? (
        <span className="text-sm font-semibold leading-none" aria-hidden="true">
          {sender.initial}
        </span>
      ) : image || (!sender.icon && !sender.fallbackIcon) ? (
        <AvatarImageWithFallback
          src={image}
          alt=""
          className={fullSize ? 'w-full h-full object-cover' : `${className} rounded-full object-cover`}
        />
      ) : (
        <ConnectorIcon
          iconSpec={sender.icon}
          fallbackIcon={sender.fallbackIcon}
          className={fullSize ? 'w-5 h-5' : className}
        />
      )}
      {message && (
        <span
          data-member-avatar-ring
          aria-hidden="true"
          className={`pointer-events-none absolute inset-0 ${shape === 'rounded-square' ? 'rounded-lg' : 'rounded-full'}`}
          style={{ boxShadow: `inset 0 0 0 1px ${sender.color}` }}
        />
      )}
    </Frame>
  );
}
