import { useRef } from 'react';
import type { SharedArtifact } from './collective-artifact-client.js';
import { useCollectiveLanguage, useCollectiveText } from './collective-copy.js';
import { SharedArtifactAnnotations } from './SharedArtifactAnnotations.js';
import { SharedArtifactDocument } from './SharedArtifactDocument.js';
import { SharedArtifactModificationCompare } from './SharedArtifactModificationCompare.js';
import { useSharedArtifactReading } from './SharedArtifactReading.js';
import { SharedArtifactRequestCards } from './SharedArtifactRequestCards.js';
import { SharedArtifactToolbar } from './SharedArtifactToolbar.js';
import { useSharedArtifacts } from './use-collective-artifacts.js';

export function SharedArtifactSurface({
  onReturnToSource,
  onOpenDiscussion,
}: {
  readonly onReturnToSource: (channelId: string, eventId: string) => void;
  readonly onOpenDiscussion: () => void;
}) {
  const language = useCollectiveLanguage();
  const t = useCollectiveText();
  const shared = useSharedArtifacts();
  const artifact = shared?.catalogue.find((item) => item.artifactId === shared.selected?.artifactId);
  const selectedRevision = shared?.selected?.ownerRevision;
  const { view, inaccessible, unavailable, error } = useSharedArtifactReading() ?? {};
  // Only management metadata may remain here after self-revoke; its own read still requires fresh manager authority.
  const managed = useRef<SharedArtifact>();
  if (artifact) managed.current = artifact;
  if (!shared?.selected) managed.current = undefined;
  if (!shared?.selected) return null;
  const managementArtifact = managed.current?.artifactId === shared.selected.artifactId ? managed.current : undefined;
  const infoKey = `${managementArtifact?.serviceInstanceId}:${managementArtifact?.collectiveId}:${shared.selected.artifactId}:${shared.humanId}`;
  const latestRevision = artifact?.versions.at(-1)?.ownerRevision;
  const comparing =
    view?.modifications?.requests.find((request) => request.requestId === shared.selected?.requestId) ??
    shared.selected.request;
  const returnToSource = () => {
    shared.close();
    if (artifact) onReturnToSource(artifact.sourceLocation.channelId, artifact.sourceEventId);
  };
  if (artifact && (artifact.mediaType === 'image/png' || artifact.mediaType === 'video/mp4'))
    return (
      <section className="shared-artifact-state" aria-label={t('作品模式')}>
        <h2>{artifact.title}</h2>
        <p>{t('在已连接的 Café 中查看画面与批注。独立窗口请从自己的 Café 打开共同体。')}</p>
        <button type="button" onClick={returnToSource}>
          {t('返回原讨论')}
        </button>
      </section>
    );
  return (
    <section className="shared-artifact-surface" aria-label={t('作品模式')}>
      <SharedArtifactToolbar
        key={infoKey}
        artifact={artifact}
        managementArtifact={managementArtifact}
        ownerRevision={selectedRevision ?? latestRevision}
        onReturnToSource={returnToSource}
        onOpenDiscussion={onOpenDiscussion}
      />
      {inaccessible ? (
        <div className="shared-artifact-state" role="alert">
          <h2>{t('你已无法查看这件作品')}</h2>
          <p>{t('作品内容和引用已关闭。你的登录仍然保留。')}</p>
          <button type="button" onClick={shared.close}>
            {t('返回频道')}
          </button>
        </div>
      ) : unavailable || error ? (
        <div className="shared-artifact-state" role="alert">
          <h2>{t('暂时无法打开作品')}</h2>
          <p>
            {artifact?.availability === 'owner_unavailable'
              ? t('内容所在的 Café 暂时不可用，讨论和草稿仍在原处。')
              : t(error?.message ?? '正在重新连接共同体。')}
          </p>
          <button type="button" onClick={() => void shared.refresh()}>
            {t('重新读取')}
          </button>
        </div>
      ) : !view ? (
        <output className="shared-artifact-state">{t('正在读取作品…')}</output>
      ) : null}
      {view && artifact && (
        <>
          {view.view.historyReadOnly && (
            <p className="shared-artifact-history-banner">
              {language === 'en'
                ? `Version ${view.ownerRevision} · historical version, read only `
                : `第 ${view.ownerRevision} 版 · 历史版本，只读查看 `}
              <button type="button" onClick={() => shared.open(artifact)}>
                {t('回到最新版')}
              </button>
            </p>
          )}
          <SharedArtifactRequestCards view={view} hidden={Boolean(comparing)} />
          {comparing ? (
            <SharedArtifactModificationCompare
              artifact={artifact}
              request={comparing}
              onClose={() => shared.compare(undefined)}
              onRework={onOpenDiscussion}
            />
          ) : (
            <div className="shared-artifact-reading-area">
              <SharedArtifactDocument view={view} />
              <SharedArtifactAnnotations view={view} onOpenDiscussion={onOpenDiscussion} />
            </div>
          )}
          <footer className="shared-artifact-footer">
            <span>
              {language === 'en'
                ? `Version ${view.ownerRevision} · reading the same document as other members`
                : `第 ${view.ownerRevision} 版 · 与成员阅读同一份正文`}
            </span>
            <button type="button" onClick={returnToSource}>
              {t('回到原讨论')}
            </button>
          </footer>
        </>
      )}
    </section>
  );
}
