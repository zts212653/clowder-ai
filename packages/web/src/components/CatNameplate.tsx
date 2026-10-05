'use client';

import { catColorVar } from '@/lib/cat-slug';
import { CatAvatar } from './CatAvatar';

interface CatNameplateProps {
  catId: string;
  /** What the plate calls the cat (the cat's display name as the rest of the message shows it). */
  name: string;
  /** Hover text for the name; defaults to the name itself. */
  title?: string;
  /** The cat is speaking right now: the avatar carries the same streaming state it carries elsewhere. */
  streaming?: boolean;
  /** Opens the cat's editor, as the avatar in the old bubble layout does. */
  onEditCat?: () => void;
}

/**
 * F322 B segment 1 — the cat's nameplate at the head of a reply (DESIGN.md「对话」).
 *
 * One 26px plate: a 16px avatar and the name (13px / 600). Its fill is this cat's surface role in the active theme,
 * fading to transparent from top to bottom, so on one screen a cat is one small patch of colour instead of a framed
 * block. The name is the theme's cat-name role. Both come from the F056 role tokens (`--color-{slug}-surface`,
 * `--color-{slug}-text`), never from a colour written here, so a dark or tuned theme re-colours the plate with the rest
 * of the cat's tokens. The time and the message's badges follow the plate in the header row; they are not part of it.
 */
export function CatNameplate({ catId, name, title, streaming = false, onEditCat }: CatNameplateProps) {
  return (
    <span
      data-testid="cat-nameplate"
      data-cat-id={catId}
      className="inline-flex h-[26px] min-w-0 max-w-full shrink items-center gap-1.5 rounded-t-lg pl-2 pr-2.5"
      style={{ backgroundImage: `linear-gradient(to bottom, ${catColorVar(catId, 'surface')}, transparent)` }}
    >
      <CatAvatar catId={catId} size={16} ring="none" status={streaming ? 'streaming' : undefined} onClick={onEditCat} />
      <span
        data-testid="cat-nameplate-name"
        className="min-w-0 truncate text-compact font-semibold"
        style={{ color: catColorVar(catId, 'text') }}
        title={title ?? name}
      >
        {name}
      </span>
    </span>
  );
}
