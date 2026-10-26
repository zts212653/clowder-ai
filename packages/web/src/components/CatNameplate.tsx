'use client';

import { useRef } from 'react';
import { useCatData } from '@/hooks/useCatData';
import { catColorVar } from '@/lib/cat-slug';
import { resolveMessageSender, type SenderMeta } from '@/lib/resolve-sender';
import { useCatProfileCard } from './cat-profile-card/CatProfileCardContext';
import { catProfileCardCopy } from './cat-profile-card/cat-profile-card.shell-copy';
import { MessageNameplate } from './MessageNameplate';
import { useShellCopy } from './shell/shell-copy';

interface CatNameplateProps {
  catId: string;
  sender?: SenderMeta;
  /** What the plate calls the cat (the cat's display name as the rest of the message shows it). */
  name: string;
  /** Hover text for the name; defaults to the name itself. */
  title?: string;
  /** Classic/standalone fallback; a v2 conversation opens its scoped cat card. */
  onEditCat?: () => void;
}

/** The nameplate supplies its working-surface gap; sender identity stays shared. */
export function CatNameplate({ catId, name, title, onEditCat, sender }: CatNameplateProps) {
  const { getCatById } = useCatData();
  const card = useCatProfileCard();
  const copy = useShellCopy(catProfileCardCopy);
  const anchor = useRef<HTMLSpanElement>(null);
  const open = card ? () => anchor.current && card.open(catId, anchor.current) : onEditCat;
  const identity =
    sender ??
    resolveMessageSender({ from: { kind: 'agent', catId } }, getCatById, {
      name: '',
      aliases: [],
      mentionPatterns: [],
    });
  return (
    <MessageNameplate
      anchorRef={anchor}
      id={catId}
      name={name}
      title={title}
      surface={catColorVar(catId, 'surface')}
      ink={catColorVar(catId, 'text')}
      sender={identity}
      onClick={open}
      actionLabel={card ? copy.title(name) : undefined}
      kind="cat"
    />
  );
}
