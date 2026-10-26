'use client';

import { Nameplate } from '@cat-cafe/ui';
import type { Ref } from 'react';
import type { SenderMeta } from '@/lib/resolve-sender';
import { SenderAvatar } from './SenderAvatar';

interface MessageNameplateProps {
  id: string;
  name: string;
  title?: string;
  surface: string;
  ink: string;
  sender: SenderMeta;
  onClick?: () => void;
  anchorRef?: Ref<HTMLSpanElement>;
  actionLabel?: string;
  kind?: 'cat' | 'member';
  avatarShape?: 'round' | 'rounded-square';
}

/** Shared member identity plate; cats and plugins provide identity, not shell markup. */
export function MessageNameplate({
  id,
  name,
  title,
  surface,
  ink,
  sender,
  onClick,
  anchorRef,
  actionLabel,
  kind = 'member',
  avatarShape = 'round',
}: MessageNameplateProps) {
  return (
    <Nameplate
      id={id}
      name={name}
      title={title}
      surface={surface}
      ink={ink}
      kind={kind}
      avatarShape={avatarShape}
      onClick={onClick}
      anchorRef={anchorRef}
      avatar={
        <SenderAvatar
          sender={sender}
          presentation="nameplate"
          shape={avatarShape}
          onClick={onClick}
          actionLabel={actionLabel}
        />
      }
    />
  );
}
