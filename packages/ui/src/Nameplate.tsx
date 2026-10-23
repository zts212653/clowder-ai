import type { ReactNode } from 'react';
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
}: {
  readonly id: string;
  readonly name: string;
  readonly avatar: ReactNode;
  readonly surface: string;
  readonly ink: string;
  readonly title?: string;
  readonly kind?: 'cat' | 'human' | 'member';
  readonly avatarShape?: 'round' | 'rounded-square';
}) {
  return (
    <span
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
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users focus this static identity to read its full identity tooltip. */}
        <span data-testid="cat-nameplate-name" className="cafe-nameplate-name" style={{ color: ink }} tabIndex={0}>
          {name}
        </span>
      </AppTooltip>
    </span>
  );
}
