import { createHash } from 'node:crypto';
import type { MemoryLifecycleStatus, TasteMemoryOwnerAction } from '@cat-cafe/shared';

export interface TasteOwnerActionEvidence {
  action: TasteMemoryOwnerAction['action'];
  commandDigest: string;
  applied: boolean;
  revision?: string;
  status?: MemoryLifecycleStatus;
}

export interface TasteLifecycleRow {
  memory_id: string;
  status: 'active' | 'retired' | 'forgotten' | 'mutating';
  projected_revision: string | null;
  last_request_id: string | null;
}

export interface TasteEvidenceRow {
  action: TasteMemoryOwnerAction['action'];
  command_digest: string;
  target_revision: string | null;
  result_status: string | null;
  applied_at: string | null;
  previous_row_exists: 0 | 1;
  previous_status: TasteLifecycleRow['status'] | null;
  previous_revision: string | null;
}

export function tasteOwnerCommandDigest(command: TasteMemoryOwnerAction): string {
  return `sha256:${createHash('sha256').update(canonicalJson(command)).digest('hex')}`;
}

export function tasteCandidateRevision(input: {
  ownerUserId: string;
  sourcePath: string;
  sourceRevision: string;
  takeaway: string;
}): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify([input.ownerUserId, input.sourcePath, input.sourceRevision, input.takeaway.trim()]))
    .digest('hex')}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(',')}}`;
}
