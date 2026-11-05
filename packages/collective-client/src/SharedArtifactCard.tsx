import { AppTooltip } from '@cat-cafe/ui';
import { useState } from 'react';
import type { SharedArtifact } from './collective-artifact-client.js';
import { useCollectiveLanguage, useCollectiveText } from './collective-copy.js';
import { SharedArtifactHistory } from './SharedArtifactHistory.js';
import { useSharedArtifacts } from './use-collective-artifacts.js';

export function artifactMediaLabel(artifact: SharedArtifact) {
  return artifact.mediaType === 'text/markdown'
    ? 'Markdown'
    : artifact.mediaType.startsWith('image/')
      ? '图片'
      : '视频';
}

export function SharedArtifactCard({
  artifact,
  presentation = 'row',
}: {
  readonly artifact: SharedArtifact;
  readonly presentation?: 'row' | 'tile';
}) {
  const shared = useSharedArtifacts();
  const t = useCollectiveText();
  const language = useCollectiveLanguage();
  const [historyOpen, setHistoryOpen] = useState(false);
  const mediaLabel = t(artifactMediaLabel(artifact));
  const latest = artifact.versions.at(-1);
  const author = shared?.humanName(latest?.adoptedByHumanId ?? artifact.publishedByHumanId);
  const media = artifact.mediaType.startsWith('image/') || artifact.mediaType.startsWith('video/');
  return (
    <article className={`shared-artifact-item shared-artifact-item-${presentation}`}>
      <button
        type="button"
        className={`shared-artifact-card shared-artifact-card-${presentation}`}
        onClick={() => shared?.open(artifact)}
      >
        <span
          className={presentation === 'tile' ? 'shared-artifact-preview' : 'shared-artifact-page'}
          aria-hidden="true"
        >
          <svg aria-hidden="true" viewBox="0 0 32 36" fill="none" stroke="currentColor" strokeWidth="1.3">
            <path d="M8 3h12l6 6v24H6V3h2Zm12 0v7h6M10 17h12M10 22h12M10 27h8" />
          </svg>
          {presentation === 'tile' && <span>{mediaLabel}</span>}
        </span>
        <span className="shared-artifact-caption">
          <AppTooltip label={artifact.title} intent="content">
            <strong>{artifact.title}</strong>
          </AppTooltip>
          <small>
            {presentation === 'tile' ? author : mediaLabel} · {t('第')} {latest?.ownerRevision} {t('版')} ·{' '}
            {presentation === 'row'
              ? author
              : latest && (
                  <time dateTime={latest.recordedAt}>
                    {new Date(latest.recordedAt).toLocaleDateString(language === 'en' ? 'en-US' : 'zh-CN', {
                      month: 'short',
                      day: 'numeric',
                    })}
                  </time>
                )}
          </small>
          {artifact.availability === 'owner_unavailable' && <small>{t('内容所在的 Café 暂时不可用')}</small>}
          <small>
            #{artifact.sourceLocation.channelId} · {t('查看批注')}
          </small>
        </span>
        {presentation === 'row' && <span className="shared-artifact-open">{t('打开')} ›</span>}
      </button>
      {presentation === 'tile' && shared?.returnToSource && (
        <AppTooltip label={t('在原讨论中打开')}>
          <button
            type="button"
            className="shared-artifact-source"
            aria-label={`${t('在原讨论中打开')} · ${artifact.title}`}
            onClick={() => shared.returnToSource?.(artifact.sourceLocation.channelId, artifact.sourceEventId)}
          >
            ↗
          </button>
        </AppTooltip>
      )}
      {(media || presentation === 'tile') && (
        <details className="shared-artifact-card-menu">
          <summary aria-label={t('更多作品操作')}>⋯</summary>
          <button type="button" onClick={() => setHistoryOpen(true)}>
            {t('版本记录')}
          </button>
        </details>
      )}
      {historyOpen && <SharedArtifactHistory artifact={artifact} onClose={() => setHistoryOpen(false)} />}
    </article>
  );
}
