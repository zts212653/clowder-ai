import type { ContextAttachment, ProjectScreeningContextAttachment, VideoProjectFrozenInput } from '@cat-cafe/shared';

export const PROJECT_SCREENING_GROUP_CONFLICT =
  '一条审片意见只能对应同一版成片。请先发送或移除输入框里的原位置，再添加这版成片的位置。';

function sameFrozenReference(left: VideoProjectFrozenInput, right: VideoProjectFrozenInput) {
  return (
    left.contentRef === right.contentRef &&
    left.ownerRevision === right.ownerRevision &&
    left.blobDigest === right.blobDigest
  );
}
function sameScreeningSource(left: ProjectScreeningContextAttachment, right: ProjectScreeningContextAttachment) {
  return (
    left.contentRef === right.contentRef &&
    left.screeningId === right.screeningId &&
    sameFrozenReference(left.input, right.input) &&
    sameFrozenReference(left.media, right.media)
  );
}

/** Admission only: legacy drafts/messages remain readable and are never silently normalized or discarded. */
export function projectScreeningComposerConflict(attachments: readonly ContextAttachment[]): string | null {
  const screenings = attachments.filter((item) => item.kind === 'project-screening');
  const first = screenings[0];
  if (!first) return null;
  if (
    attachments.some(
      (item) =>
        item.kind === 'media' ||
        item.kind === 'quote' ||
        (item.kind === 'project-screening' && !sameScreeningSource(first, item)),
    )
  )
    return PROJECT_SCREENING_GROUP_CONFLICT;
  if (new Set(screenings.map((item) => item.id)).size !== screenings.length)
    return '这个审片位置已经在输入框里。请先发送或移除原位置，再重新标记。';
  const selections = screenings.reduce((count, item) => count + item.selections.length, 0);
  // The actual project takeover's intent.selections admits at most twelve selected places per message.
  if (selections > 12) return '一条审片意见最多 12 处位置。请先发送或移除一些位置，再继续标记。';
  return null;
}
