import type { ArtifactReviewRound, ArtifactReviewView } from '@cat-cafe/shared';
import { useState } from 'react';
import { useShellPresentation } from '@/components/shell/shell-presentation';
import { useArtworkChrome, useRegisterArtworkHistory } from './ArtworkChrome';
import { artifactRoundRequestSource } from './artifact-modification-source';
import { ContentModificationLanding } from './ContentModificationLanding';
import { modificationSourceVersion } from './modification-draft';
import type { ReviewDraft } from './useReviewDraft';

/** Task is already owned. Confirming a new request records it without re-admitting or rewriting that Task. */
export function ArtifactModificationEntry({
  view,
  round,
  draft,
  disabled,
  allowNewRequest = true,
  onRegionHandedOff,
}: {
  view: ArtifactReviewView;
  round: ArtifactReviewRound;
  draft: ReviewDraft;
  disabled: boolean;
  allowNewRequest?: boolean;
  /** The chosen region now belongs to a recorded erase request; the canvas selection is released. */
  onRegionHandedOff?: () => void;
}) {
  const [open, setOpen] = useState(false);
  useRegisterArtworkHistory(() => setOpen(true));
  const chrome = useArtworkChrome();
  const unifiedHistory = useShellPresentation() === 'v2' && !!chrome && !allowNewRequest;
  const named = artifactRoundRequestSource(view, round);
  if (!named)
    return (
      <p role="alert" className="p-3 text-xs text-cafe-error">
        原讨论版本尚未核对，请刷新后继续修改。
      </p>
    );
  const { source, taskContext } = named;
  return (
    <>
      {!unifiedHistory ? (
        <div className="flex justify-end px-3 py-2">
          <button
            type="button"
            data-testid="content-modification-entry"
            onClick={() => setOpen(true)}
            className="rounded-md border border-cafe-subtle px-3 py-1.5 text-xs font-semibold text-cafe-accent"
          >
            {disabled || !allowNewRequest ? '修改记录' : '请猫修改'}
          </button>
        </div>
      ) : null}
      {open ? (
        <ContentModificationLanding
          title={view.review.title}
          ownerUserId={view.review.task.ownerUserId}
          source={source}
          mediaType={round.asset.mediaType}
          taskContext={taskContext}
          suggestedCatId={view.authority.ownerCatId ?? undefined}
          suggestedThreadId={view.review.task.threadId}
          initialIntent={draft.anchor ? { selection: draft.anchor } : {}}
          initialIntentSourceVersion={modificationSourceVersion(source)}
          allowNewRequest={allowNewRequest && !disabled}
          onRequestKnown={(request) => {
            if (!allowNewRequest) return;
            const { imageEdit, selection } = request.record.payload.intent;
            if (
              imageEdit?.kind === 'erase-region' &&
              draft.anchor &&
              JSON.stringify(selection) === JSON.stringify(draft.anchor)
            )
              onRegionHandedOff?.();
          }}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
