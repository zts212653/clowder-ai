'use client';

import { Nameplate } from '@cat-cafe/ui';
import { catColorVar } from '@/lib/cat-slug';
import { CatAvatar } from './CatAvatar';
export function CatNameplate({
  catId,
  name,
  title,
  onEditCat,
}: {
  catId: string;
  name: string;
  title?: string;
  onEditCat?: () => void;
}) {
  return (
    <Nameplate
      id={catId}
      name={name}
      title={title}
      surface={catColorVar(catId, 'surface')}
      ink={catColorVar(catId, 'text')}
      avatar={<CatAvatar catId={catId} size={32} ring="none" onClick={onEditCat} />}
    />
  );
}
