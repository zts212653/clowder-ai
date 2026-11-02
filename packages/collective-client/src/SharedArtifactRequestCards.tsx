import type { CollectiveModificationProjection } from '@cat-cafe/shared';
import type { SharedArtifact, SharedMarkdownView } from './collective-artifact-client.js';
import { useCollectiveLanguage, useCollectiveText } from './collective-copy.js';
import { sharedArtifactRequestState } from './shared-artifact-request-state.js';
import { useSharedArtifacts } from './use-collective-artifacts.js';
import { useSharedArtifactControl } from './use-shared-artifact-control.js';
import { useSharedArtifactRequestHistory } from './use-shared-artifact-request-history.js';
import { useSharedArtifactRequestReceipt } from './use-shared-artifact-request-receipt.js';

export function SharedArtifactRequestCards({
  view,
  hidden = false,
}: {
  readonly view: SharedMarkdownView;
  readonly hidden?: boolean;
}) {
  const t = useCollectiveText();
  const shared = useSharedArtifacts();
  const artifact = shared?.catalogue.find((item) => item.contentRef === view.contentRef);
  const history = useSharedArtifactRequestHistory(artifact, view);
  const requests = history.view.modifications?.requests ?? [];
  if (!requests.length) return null;
  return (
    <section className="shared-artifact-requests" aria-label={t('作品修改')} hidden={hidden}>
      <h2>{t('修改请求')}</h2>
      {requests.map((request) => (
        <SharedArtifactRequestCard key={request.requestId} artifact={artifact} record={request} />
      ))}
      {history.view.modifications?.nextOffset !== undefined && (
        <button type="button" disabled={history.pending} onClick={() => void history.more()}>
          {t(history.pending ? '正在读取…' : '更早的修改记录')}
        </button>
      )}
      {history.error && <p role="alert">{t(history.error)}</p>}
    </section>
  );
}

function SharedArtifactRequestCard({
  artifact,
  record,
}: {
  readonly artifact?: SharedArtifact;
  readonly record: CollectiveModificationProjection;
}) {
  const language = useCollectiveLanguage();
  const t = useCollectiveText();
  const shared = useSharedArtifacts();
  const control = useSharedArtifactControl(artifact, record);
  const request = control.request;
  const receipts = useSharedArtifactRequestReceipt(request.requestEventId, request.state === 'accepted');
  const adopted = receipts.find(
    ({ artifact: work, version }) =>
      work.artifactId === artifact?.artifactId && version.lineage?.requestId === request.requestId,
  )?.version;
  return (
    <article>
      <strong>
        {shared?.catName(request.target.humanId, request.target.catId) ?? request.target.catId} ·{' '}
        {t(sharedArtifactRequestState(request))}
      </strong>
      <span>
        {language === 'en'
          ? `Based on version ${request.ownerRevision} · ${request.annotationIds.length} ${request.annotationIds.length === 1 ? 'reference' : 'references'}`
          : `基于第 ${request.ownerRevision} 版 · ${request.annotationIds.length} 处引用`}
      </span>
      <p>{shared?.sourceMessage(request.requestEventId)?.body}</p>
      {request.latestProposalRef && (
        <button type="button" onClick={() => shared?.compare(request.requestId, request)}>
          {t('查看对照')}
        </button>
      )}
      {!control.closed && control.canCancel && (
        <button type="button" disabled={control.pending} onClick={() => void control.resolve('cancel')}>
          {t(control.pending ? '正在核对决定…' : '取消这次修改')}
        </button>
      )}
      {adopted && (
        <output>
          {language === 'en' ? `Adopted as version ${adopted.ownerRevision}` : `已采用为第 ${adopted.ownerRevision} 版`}
        </output>
      )}
      {control.error && <p role="alert">{t(control.error)}</p>}
    </article>
  );
}
