import { useEffect, useRef } from 'react';
import type { SharedArtifact } from './collective-artifact-client.js';
import { useCollectiveLanguage, useCollectiveText } from './collective-copy.js';
import { useSharedArtifacts } from './use-collective-artifacts.js';
import { useSharedArtifactVersionHistory } from './use-shared-artifact-version-history.js';

export function SharedArtifactHistory({
  artifact,
  ownerRevision,
  onClose,
}: {
  readonly artifact: SharedArtifact;
  readonly ownerRevision?: number;
  readonly onClose: () => void;
}) {
  const language = useCollectiveLanguage();
  const t = useCollectiveText();
  const shared = useSharedArtifacts();
  const history = useSharedArtifactVersionHistory(artifact);
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    close.current?.focus();
  }, []);
  return (
    <dialog
      open
      className="shared-artifact-information shared-artifact-history"
      aria-label={t('版本记录')}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <header>
        <h2>{t('版本记录')}</h2>
        <button ref={close} type="button" aria-label={t('关闭版本记录')} onClick={onClose}>
          ×
        </button>
      </header>
      <ol>
        {history.page?.versions.map((version) => {
          const message = version.lineage && shared?.sourceMessage(version.lineage.requestEventId);
          const author =
            message?.recipient?.kind === 'agent' && message.recipient.agentId === version.authorCatId
              ? language === 'en'
                ? `${shared?.catName(message.recipient.humanId, message.recipient.agentId)} · ${shared?.humanName(message.recipient.humanId)}'s Café`
                : `${shared?.catName(message.recipient.humanId, message.recipient.agentId)} · ${shared?.humanName(message.recipient.humanId)}的 Café`
              : t('原请求中的具名猫');
          return (
            <li key={version.ownerRevision}>
              <h3>
                {language === 'en' ? `Version ${version.ownerRevision}` : `第 ${version.ownerRevision} 版`}
                {version.ownerRevision === ownerRevision && <small> · {t('正在查看')}</small>}
              </h3>
              <p>
                {version.adoptedByHumanId
                  ? language === 'en'
                    ? `${shared?.humanName(version.adoptedByHumanId)} adopted ${author}'s changes.`
                    : `${shared?.humanName(version.adoptedByHumanId)}采用了${author}的修改。`
                  : language === 'en'
                    ? `Shared by ${shared?.humanName(artifact.publishedByHumanId)}.`
                    : `${shared?.humanName(artifact.publishedByHumanId)}分享的版本。`}
              </p>
              <time dateTime={version.recordedAt}>
                {new Date(version.recordedAt).toLocaleString(language === 'en' ? 'en-US' : 'zh-CN')} {t('记录')}
              </time>
              <div>
                <button
                  type="button"
                  onClick={() => {
                    shared?.open(artifact, version.ownerRevision);
                    onClose();
                  }}
                >
                  {language === 'en' ? `View version ${version.ownerRevision}` : `查看第 ${version.ownerRevision} 版`}
                </button>
                {version.lineage && (
                  <button
                    type="button"
                    aria-label={
                      language === 'en'
                        ? `View the request for version ${version.ownerRevision} in the discussion`
                        : `在讨论中查看第 ${version.ownerRevision} 版的请求`
                    }
                    onClick={() => {
                      if (!version.lineage) return;
                      shared?.close();
                      shared?.returnToSource?.(version.lineage.location.channelId, version.lineage.requestEventId);
                    }}
                  >
                    {t('在讨论中查看')}
                  </button>
                )}
              </div>
              <details>
                <summary>{t(version.adoptedByHumanId ? '采用回执与版本指纹' : '分享回执与版本指纹')}</summary>
                <code>{version.receiptRef}</code>
                <code>{version.blobDigest}</code>
              </details>
            </li>
          );
        })}
      </ol>
      {history.pending && <output>{t('正在读取版本记录…')}</output>}
      {history.error && <p role="alert">{t(history.error)}</p>}
      {history.page?.nextOffset !== undefined && (
        <button type="button" disabled={history.pending} onClick={() => void history.more()}>
          {language === 'en'
            ? `Earlier versions (${history.page.versions.length}/${history.page.total} read)`
            : `更早的版本（已读 ${history.page.versions.length}/${history.page.total}）`}
        </button>
      )}
    </dialog>
  );
}
