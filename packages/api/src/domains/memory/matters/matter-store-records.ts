import type {
  MatterMutationReceipt,
  MatterSourceReference,
  MatterWriteSnapshot,
  MemoryMatter,
  MessageFrom,
} from '@cat-cafe/shared';
import type { MatterAccessGuard } from './matter-access.js';

export interface StoredMatter extends MemoryMatter {
  ownerUserId: string;
  descriptionEntryId?: string;
  accessGuards: MatterAccessGuard[];
}
export interface StoredMatterEntry {
  entryId: string;
  source: MatterSourceReference;
  summary?: string;
  summaryAuthor?: MessageFrom;
  recordedAt?: number;
  status: 'active' | 'superseded' | 'retired';
  supersededBy?: string;
}
export interface MatterRow {
  matter_id: string;
  owner_user_id: string;
  title: string;
  description: string;
  description_author_json: string | null;
  description_entry_id: string | null;
  access_guards_json: string | null;
  revision: number;
  status: 'active' | 'retired';
  created_at: number;
  updated_at: number;
}
export interface EntryRow {
  entry_id: string;
  source_json: string;
  status: StoredMatterEntry['status'];
  superseded_by: string | null;
  summary: string | null;
  summary_author_json: string | null;
  created_at: number;
}
export interface RequestRow {
  fingerprint: string;
  matter_id: string;
  result_json: string;
}
export interface StoredWriteReceipt extends MatterMutationReceipt {
  snapshot?: MatterWriteSnapshot;
}
export function fromRow(row: MatterRow): StoredMatter {
  return {
    matterId: row.matter_id,
    ownerUserId: row.owner_user_id,
    title: row.title,
    description: row.description,
    ...(row.description_entry_id ? { descriptionEntryId: row.description_entry_id } : {}),
    accessGuards: row.access_guards_json ? (JSON.parse(row.access_guards_json) as MatterAccessGuard[]) : [],
    ...(row.description_author_json
      ? { descriptionAuthor: JSON.parse(row.description_author_json) as MessageFrom }
      : {}),
    revision: row.revision,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
