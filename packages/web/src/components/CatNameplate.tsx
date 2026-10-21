'use client';

import { Nameplate } from '@cat-cafe/ui';
import { useCatData } from '@/hooks/useCatData';
import { catColorVar } from '@/lib/cat-slug';
import { resolveMessageSender, type SenderMeta } from '@/lib/resolve-sender';
import { SenderAvatar } from './SenderAvatar';

interface CatNameplateProps {
  catId: string;
  sender?: SenderMeta;
  /** What the plate calls the cat (the cat's display name as the rest of the message shows it). */
  name: string;
  /** Hover text for the name; defaults to the name itself. */
  title?: string;
  /** Opens the cat's editor, as the avatar in the old bubble layout does. */
  onEditCat?: () => void;
}

/** The nameplate supplies its working-surface gap; sender identity stays shared. */
export function CatNameplate({ catId, name, title, onEditCat, sender }: CatNameplateProps) {
  const { getCatById } = useCatData();
  const identity =
    sender ??
    resolveMessageSender({ from: { kind: 'agent', catId } }, getCatById, {
      name: '',
      aliases: [],
      mentionPatterns: [],
    });
  return (
    <Nameplate
      id={catId}
      name={name}
      title={title}
      surface={catColorVar(catId, 'surface')}
      ink={catColorVar(catId, 'text')}
      avatar={<SenderAvatar sender={identity} presentation="nameplate" onClick={onEditCat} />}
    />
  );
}
