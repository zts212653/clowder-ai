import type { CollectiveModificationProjection } from '@cat-cafe/shared';
import { useEffect, useRef, useState } from 'react';
import { CollectiveClientRequestError } from './client-request.js';
import type { SharedArtifact } from './collective-artifact-client.js';
import { useCollectiveLanguage, useCollectiveText } from './collective-copy.js';
import { useSharedArtifactReading } from './SharedArtifactReading.js';
import type { SharedArtifactModificationPreview } from './shared-artifact-modification-client.js';
import { useSharedArtifacts } from './use-collective-artifacts.js';
import { useSharedArtifactControl } from './use-shared-artifact-control.js';
import { useSharedArtifactRequestReceipt } from './use-shared-artifact-request-receipt.js';

/** This view renders the existing owner's exact edits; it owns no patch engine or draft. */
export function SharedArtifactModificationCompare({
  artifact,
  request,
  onClose,
  onRework,
}: {
  readonly artifact: SharedArtifact;
  readonly request: CollectiveModificationProjection;
  readonly onClose: () => void;
  readonly onRework?: () => void;
}) {
  const language = useCollectiveLanguage();
  const t = useCollectiveText();
  const shared = useSharedArtifacts();
  const reading = useSharedArtifactReading();
  const control = useSharedArtifactControl(artifact, request);
  const api = shared?.api;
  const [preview, setPreview] = useState<SharedArtifactModificationPreview>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const [written, setWritten] = useState<number>();
  const fence = `${artifact.serviceInstanceId}:${artifact.collectiveId}:${artifact.artifactId}:${artifact.accessRevision}:${request.requestId}:${request.latestProposalRef}`;
  const current = useRef(fence);
  current.current = fence;
  // biome-ignore lint/correctness/useExhaustiveDependencies: fence pins the resource, access and exact owner proposal; ordinary catalogue identity is not a new preview.
  useEffect(() => {
    let active = true;
    setPreview(undefined);
    setError(undefined);
    setWritten(undefined);
    if (!api || !request.latestProposalRef) return;
    void api
      .previewModification(artifact, { requestId: request.requestId, proposalRef: request.latestProposalRef })
      .then(
        (value) => {
          if (active) setPreview(value);
        },
        () => {
          if (active) setError('对照暂时无法读取，请返回作品后重试。');
        },
      );
    return () => {
      active = false;
      current.current = '';
    };
  }, [api, fence]);
  const latestVersion = artifact.versions.at(-1);
  const latest = Math.max(latestVersion?.ownerRevision ?? 0, preview?.currentOwnerRevision ?? 0);
  const receipts = useSharedArtifactRequestReceipt(request.requestEventId, request.state === 'accepted');
  const adopted =
    receipts.find(
      ({ artifact: work, version }) =>
        work.artifactId === artifact.artifactId &&
        version.lineage?.requestId === request.requestId &&
        version.lineage.proposalRef === request.latestProposalRef,
    )?.version.ownerRevision ?? written;
  const stale = latest !== request.ownerRevision;
  const rework = () => {
    if (!shared || !reading || !request.latestProposalRef || latestVersion?.ownerRevision !== latest) return;
    const target = shared.reworkRecipient(request.target, artifact.sourceLocation.channelId, request.requestEventId);
    reading.setRework({
      artifactId: artifact.artifactId,
      ownerRevision: latest,
      blobDigest: latestVersion.blobDigest,
      sourceOwnerRevision: request.ownerRevision,
      rework: { requestId: request.requestId, proposalRef: request.latestProposalRef },
      ...target,
    });
    shared.open(artifact);
    onRework?.();
  };
  const adopt = async () => {
    if (!api || !preview || pending || control.pending) return;
    setPending(true);
    setError(undefined);
    try {
      const result = await api.adoptModification(artifact, preview);
      if (current.current !== fence) return;
      setWritten(result.receipt.ownerRevision);
      await shared.refresh();
      await shared.refreshDiscussion?.();
    } catch (failure) {
      if (current.current !== fence) return;
      setError(
        failure instanceof CollectiveClientRequestError && failure.status === 409
          ? '版本或决定已改变，正在核对作品记录。'
          : '采用结果尚未确认，修改仍保留。请核对并重试原操作。',
      );
      await shared?.refresh();
    } finally {
      if (current.current === fence) setPending(false);
    }
  };
  return (
    <section className="shared-artifact-compare" aria-label={t('修改前后对比')}>
      <header>
        <strong>
          {language === 'en'
            ? `${shared?.catName(request.target.humanId, request.target.catId)}'s changes · based on version ${request.ownerRevision}`
            : `${shared?.catName(request.target.humanId, request.target.catId)}提交的修改 · 基于第 ${request.ownerRevision} 版`}
        </strong>
        <button type="button" onClick={onClose}>
          {t('返回作品')}
        </button>
      </header>
      {!preview && !error && <output>{t('正在读取对照…')}</output>}
      {preview && (
        <>
          <p>{preview.proposal.response}</p>
          {preview.proposal.edits.map((edit, index) => (
            <div key={`${edit.start}:${edit.end}:${index}`} className="shared-artifact-edit">
              <div>
                <h3>{t('原文')}</h3>
                <pre>
                  <del>{edit.expectedText || t('（此处原无内容）')}</del>
                </pre>
              </div>
              <div>
                <h3>{t('修改后')}</h3>
                <pre>
                  <ins>{edit.replacement || t('（删除此处内容）')}</ins>
                </pre>
              </div>
            </div>
          ))}
        </>
      )}
      <footer>
        {!adopted && !control.closed && artifact.canApply && (
          <button
            type="button"
            disabled={!preview || pending || control.pending}
            onClick={() => void control.resolve('reject')}
          >
            {t(control.pending ? '正在核对决定…' : '不采用')}
          </button>
        )}
        {adopted ? (
          <output>{language === 'en' ? `Adopted as version ${adopted}` : `已采用为第 ${adopted} 版`}</output>
        ) : control.closed ? (
          <output>{t(closedRequestLabel(control.request))}</output>
        ) : stale ? (
          <div>
            <p>
              {language === 'en'
                ? `These changes are based on version ${request.ownerRevision}; the work is now version ${latest}.`
                : `这份修改基于第 ${request.ownerRevision} 版，现在已是第 ${latest} 版`}
            </p>
            <button
              type="button"
              disabled={!preview || !reading || latestVersion?.ownerRevision !== latest}
              onClick={rework}
            >
              {language === 'en'
                ? `Ask ${shared?.catName(request.target.humanId, request.target.catId)} to redo this from version ${latest}…`
                : `请${shared?.catName(request.target.humanId, request.target.catId)}基于第 ${latest} 版重做…`}
            </button>
          </div>
        ) : !artifact.canApply ? (
          <p>{t('采用由有权成员决定，你仍可参与讨论。')}</p>
        ) : (
          <button type="button" disabled={!preview || pending || control.pending} onClick={() => void adopt()}>
            {t(pending ? '正在核对采用回执…' : '采用')}
          </button>
        )}
        {control.error && <p role="alert">{t(control.error)}</p>}
        {error && !adopted && <p role="alert">{t(error)}</p>}
      </footer>
    </section>
  );
}

function closedRequestLabel(request: CollectiveModificationProjection) {
  if (request.state === 'accepted') return '已采用，正在核对版本记录。';
  if (request.state === 'unavailable') return '这次修改暂时无法继续，请在当前保管方下重新发起。';
  return request.resolution?.kind === 'rejected' ? '这份修改未采用。' : '这次修改已取消。';
}
