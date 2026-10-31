import type { CatData } from '@/hooks/useCatData';
import type { HubCatEditorDraft } from './hub-cat-editor.model';

export interface HubCatEditorProps {
  cat?: CatData | null;
  draft?: HubCatEditorDraft | null;
  /** All cats — used for alias uniqueness validation. */
  existingCats?: CatData[];
  /** F208 OQ-9: true when this cat has a structured dossier profile. */
  hasDossier?: boolean;
  presentation?: 'modal' | 'page';
  onDelete?: () => Promise<void> | void;
  header?: React.ReactNode;
  open: boolean;
  onClose: () => void;
  onSaved: () => Promise<void> | void;
}
