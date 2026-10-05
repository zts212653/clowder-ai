import type { UnifiedAttentionItemV1 } from '@cat-cafe/shared';
import { preparedArtifactPresentation } from '@/components/growing/prepared-artifact-presentation';

/**
 * What a 等你判断 / 需要修复 row may say. Every field comes from the F310 contract and is absent (null) when the contract
 * did not carry it: the host never fills a gap with a placeholder. "What choosing it will cause", a source feature name and
 * the time the item appeared have no field in the contract, so there is none here either (confirmed with the F310 executor).
 *
 * `workTitle` is the entrusted work's own title (`ownerRead.work.title`): it names the work the decision belongs to, not the
 * feature that raised it. `preparedWork` is the original panel's label for the prepared work — the real name is not in the
 * coordinate, so it is the neutral "准备好的作品" (plus the round for a cat-prepared review), never a ref.
 */
export interface WorkDetail {
  recommendation: string | null;
  goal: string | null;
  workTitle: string | null;
  /** The cat that currently owns the entrusted work (`ownerRead.work.ownerCatId`): whose work it is, not who raised the decision. */
  ownerCatId: string | null;
  preparedWork: string | null;
}

const absent = (): WorkDetail => ({
  recommendation: null,
  goal: null,
  workTitle: null,
  ownerCatId: null,
  preparedWork: null,
});

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function nonBlankText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

const PREPARED_COORDINATE_FIELDS = [
  'artifactRef',
  'artifactRevision',
  'completenessRef',
  'previewRef',
  'openInWorkspaceRef',
] as const;

/** Only a whole coordinate counts as prepared work; its label is the original panel's own presentation of it. */
function preparedWorkLabel(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const [artifactRef, artifactRevision, completenessRef, previewRef, openInWorkspaceRef] =
    PREPARED_COORDINATE_FIELDS.map((field) => nonBlankText(value[field]));
  if (!artifactRef || !artifactRevision || !completenessRef || !previewRef || !openInWorkspaceRef) return null;
  return preparedArtifactPresentation({
    artifactRef,
    artifactRevision,
    completenessRef,
    previewRef,
    openInWorkspaceRef,
  }).label;
}

/** The first eligible receipt of this row's own kind decides what is said; anything else linked to the task is not borrowed. */
export function eligibleReceiptOf(
  item: UnifiedAttentionItemV1,
): { receipt: Record<string, unknown>; ownerRead: Record<string, unknown> } | null {
  const entries: unknown[] = Array.isArray(item.linkedNeedsMe) ? item.linkedNeedsMe : [];
  for (const entry of entries) {
    if (!isRecord(entry) || !isRecord(entry.receipt) || !isRecord(entry.ownerRead)) continue;
    const { receipt, ownerRead } = entry;
    if (receipt.eligible === true && receipt.kind === item.kind) return { receipt, ownerRead };
  }
  return null;
}

export function readWorkDetail(item: UnifiedAttentionItemV1): WorkDetail {
  const found = eligibleReceiptOf(item);
  if (!found) return absent();
  const { receipt, ownerRead } = found;
  const outcome = isRecord(ownerRead.brief) ? ownerRead.brief.outcome : undefined;
  return {
    recommendation: nonBlankText(receipt.recommendation),
    goal: isRecord(outcome) && outcome.state === 'known' ? nonBlankText(outcome.value) : null,
    workTitle: isRecord(ownerRead.work) ? nonBlankText(ownerRead.work.title) : null,
    ownerCatId: isRecord(ownerRead.work) ? nonBlankText(ownerRead.work.ownerCatId) : null,
    preparedWork: preparedWorkLabel(ownerRead.preparedArtifact),
  };
}
