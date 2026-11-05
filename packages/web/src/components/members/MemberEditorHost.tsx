'use client';
import type { CatData } from '@/hooks/useCatData';
import { HubCatEditor } from '../HubCatEditor';
import type { HubCatEditorDraft } from '../hub-cat-editor.model';
import { useMembersCopy } from './editor-presentation';
import { MemberDetailHeader } from './MemberDetailHeader';
import type { MembersCopy } from './members.shell-copy';
export type MemberDeleteCopy = Pick<MembersCopy, 'deleteTitle' | 'deletePrompt' | 'deleteLabel' | '取消'>;

/** Shares the original editor and handlers; only v2 supplies page presentation and member-local navigation. */
export function MemberEditorHost({
  v2,
  cat,
  cats,
  draft,
  hasDossier,
  onClose,
  onSaved,
  onToggle,
  togglingCatId,
  onDelete,
}: {
  v2: boolean;
  cat: CatData | null;
  cats: CatData[];
  draft?: HubCatEditorDraft | null;
  hasDossier: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onToggle: (cat: CatData) => void;
  togglingCatId: string | null;
  onDelete: (cat: CatData, copy?: MemberDeleteCopy) => Promise<boolean>;
}) {
  const copy = useMembersCopy();
  return (
    <HubCatEditor
      open
      cat={cat}
      draft={draft}
      hasDossier={hasDossier}
      onClose={onClose}
      onSaved={onSaved}
      presentation={v2 ? 'page' : 'modal'}
      existingCats={v2 ? cats : undefined}
      header={
        v2 && cat ? (
          <MemberDetailHeader
            cat={cats.find((c) => c.id === cat.id) ?? cat}
            toggling={togglingCatId === cat.id}
            onToggle={onToggle}
          />
        ) : undefined
      }
      onDelete={
        v2 && cat
          ? async () => {
              if (await onDelete(cat, copy)) onClose();
            }
          : undefined
      }
    />
  );
}
