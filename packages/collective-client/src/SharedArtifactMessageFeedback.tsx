import { useCollectiveLanguage, useCollectiveText } from './collective-copy.js';
import { useSharedArtifactReading } from './SharedArtifactReading.js';
import { sharedArtifactRequestState } from './shared-artifact-request-state.js';
import { useSharedArtifacts } from './use-collective-artifacts.js';
import { useSharedArtifactRequestReceipt } from './use-shared-artifact-request-receipt.js';

/** System projections from owner receipts and the canonical ledger; no generated Human/Cat message is appended. */
export function SharedArtifactMessageFeedback({ eventId }: { readonly eventId: string }) {
  const language = useCollectiveLanguage();
  const t = useCollectiveText();
  const shared = useSharedArtifacts();
  const reading = useSharedArtifactReading();
  const annotations =
    reading?.view?.view.review.annotations.filter((annotation) => annotation.collectiveMessage?.eventId === eventId) ??
    [];
  const requests = reading?.view?.modifications?.requests.filter((request) => request.requestEventId === eventId) ?? [];
  const source = shared?.sourceMessage(eventId);
  const receipts = useSharedArtifactRequestReceipt(
    eventId,
    source?.actor.kind === 'human' && source.recipient?.kind === 'agent',
  );
  if (!annotations.length && !requests.length && !receipts.length) return null;
  return (
    <div className="shared-artifact-message-feedback">
      {annotations.map((annotation, index) => (
        <p key={annotation.id}>
          {language === 'en'
            ? `Reference ${index + 1} · version ${annotation.collectiveMessage?.ownerRevision} · `
            : `引用 ${index + 1} · 第 ${annotation.collectiveMessage?.ownerRevision} 版 · `}
          {'quote' in annotation.anchor ? annotation.anchor.quote : t('作品中的选区')}
        </p>
      ))}
      {requests
        .filter((request) => request.state !== 'accepted')
        .map((request) => (
          <button
            key={request.requestId}
            type="button"
            onClick={() => shared?.compare(request.requestId)}
            disabled={!request.latestProposalRef}
          >
            {shared?.catName(request.target.humanId, request.target.catId)} · {t(sharedArtifactRequestState(request))}
            {request.latestProposalRef ? ` · ${t('查看对照')}` : ''}
          </button>
        ))}
      {receipts.map(({ artifact, version }) => (
        <output key={version.receiptRef} data-source-kind="content-owner-receipt">
          <span>
            {language === 'en'
              ? `${version.adoptedByHumanId ? shared?.humanName(version.adoptedByHumanId) : t('有权成员')} adopted${version.authorCatId ? ` ${version.authorCatId}'s ` : ' '}changes · `
              : `${version.adoptedByHumanId ? shared?.humanName(version.adoptedByHumanId) : '有权成员'}采用了${version.authorCatId ? ` ${version.authorCatId} ` : ''}的修改 · `}
          </span>
          <button type="button" onClick={() => shared?.open(artifact, version.ownerRevision)}>
            {artifact.title} ·{' '}
            {language === 'en' ? `Version ${version.ownerRevision}` : `第 ${version.ownerRevision} 版`}
          </button>
        </output>
      ))}
    </div>
  );
}
