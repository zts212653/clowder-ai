import type { ReactNode, Ref } from 'react';
import { AppTooltip } from './AppTooltip';

/** Home nameplate geometry. Applications supply identity, colours and the real avatar. */
export function Nameplate({
  id,
  name,
  avatar,
  surface,
  ink,
  title,
  kind = 'cat',
  avatarShape = 'round',
  onClick,
  anchorRef,
}: {
  readonly id: string;
  readonly name: string;
  readonly avatar: ReactNode;
  readonly surface: string;
  readonly ink: string;
  readonly title?: string;
  readonly kind?: 'cat' | 'human' | 'member';
  readonly avatarShape?: 'round' | 'rounded-square';
  readonly onClick?: () => void;
  readonly anchorRef?: Ref<HTMLSpanElement>;
}) {
  const Name = onClick ? 'button' : 'span';
  return (
    <span
      ref={anchorRef}
      data-testid={`${kind}-nameplate`}
      data-cat-id={kind === 'cat' ? id : undefined}
      data-avatar-shape={avatarShape}
      className="cafe-nameplate"
      style={{ backgroundImage: `linear-gradient(to bottom, ${surface}, transparent)` }}
    >
      <span
        data-testid="cat-nameplate-avatar"
        className={`cafe-nameplate-avatar ${avatarShape === 'rounded-square' ? 'cafe-nameplate-avatar-square' : ''}`}
      >
        {avatar}
      </span>
      <AppTooltip label={title ?? name} intent="content" side="top">
        <Name
          data-testid="cat-nameplate-name"
          className="cafe-nameplate-name"
          style={{ color: ink }}
          tabIndex={0}
          type={onClick ? 'button' : undefined}
          onClick={onClick}
          aria-haspopup={onClick ? 'dialog' : undefined}
        >
          {name}
        </Name>
      </AppTooltip>
    </span>
  );
}
