'use client';
import { type EvolutionExplorationMediaV1, type EvolutionExplorationRecordV1, refIdentity } from '@cat-cafe/shared';
import { useEffect, useState } from 'react';
import { Lightbox } from '@/components/Lightbox';
import { ExplorationIcon } from './ExplorationIcon';
import { ExplorationTrace, type explorationTraceBounds } from './ExplorationTrace';

function mediaUrl(programId: string, record: EvolutionExplorationRecordV1, media: EvolutionExplorationMediaV1) {
  const query = new URLSearchParams({
    experimentRef: JSON.stringify(record.experimentRef),
    recordRef: JSON.stringify(record.recordRef),
  });
  return `/api/capability-evolution/programs/${encodeURIComponent(programId)}/exploration-media/${media.mediaRef.version}?${query}`;
}

function ImageEvidence({ src, label }: { src: string; label: string }) {
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [attempt, setAttempt] = useState(0);
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      {state === 'failed' ? (
        <div className="exploration-media-message">
          <p>这张原件暂时无法加载；本次结果仍保留。</p>
          <button
            type="button"
            onClick={() => {
              setAttempt(attempt + 1);
              setState('loading');
            }}
          >
            重试图片
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="exploration-image"
          aria-label={`放大 ${label}`}
          onClick={() => setExpanded(true)}
        >
          {/* biome-ignore lint/performance/noImgElement: exact authenticated owner bytes must not pass through an image optimizer. */}
          <img
            key={attempt}
            src={src}
            alt={label}
            onLoad={() => setState('ready')}
            onError={() => {
              setState('failed');
              setExpanded(false);
            }}
          />
          {state === 'loading' && <span role="status">正在读取图片…</span>}
        </button>
      )}
      {expanded && state === 'ready' && (
        <Lightbox url={src} alt={label} caption={label} onClose={() => setExpanded(false)} />
      )}
    </>
  );
}

function VideoEvidence({ src, label, poster }: { src: string; label: string; poster?: string }) {
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle');
  const [attempt, setAttempt] = useState(0);
  if (state === 'idle' || state === 'failed')
    return (
      <div className="exploration-video-cover">
        {poster && state === 'idle' && <ImageEvidence src={poster} label={`${label} · 归档首帧`} />}
        {state === 'failed' && <p>回放读取失败；当前实验与数值仍保留。</p>}
        <button
          type="button"
          className="exploration-play"
          onClick={() => {
            setAttempt(attempt + 1);
            setState('loading');
          }}
        >
          <ExplorationIcon kind="evidence" />
          {state === 'failed' ? '重试回放' : '在原地打开回放'}
        </button>
      </div>
    );
  return (
    <div data-playback-state={state}>
      {state === 'loading' && (
        <p role="status" className="exploration-caption">
          正在读取原始回放…
        </p>
      )}
      <video
        key={attempt}
        aria-label={label}
        src={src}
        controls
        muted
        playsInline
        preload="metadata"
        onLoadedMetadata={() => setState('ready')}
        onError={() => setState('failed')}
      />
    </div>
  );
}

/** Component identities include record and media revision, so selection never reuses an old picture. */
export function ExplorationMedia({
  programId,
  record,
  sideLabel,
  traceBounds,
  onRetry,
}: {
  programId: string;
  record: EvolutionExplorationRecordV1;
  sideLabel?: string;
  traceBounds?: ReturnType<typeof explorationTraceBounds>;
  onRetry(): void;
}) {
  const firstKey = record.media[0] ? refIdentity(record.media[0].mediaRef) : undefined;
  const [selectedMediaKey, setSelectedMediaKey] = useState(firstKey);
  useEffect(() => {
    if (!selectedMediaKey && firstKey) setSelectedMediaKey(firstKey);
  }, [firstKey, selectedMediaKey]);
  const media = record.media.find((entry) => refIdentity(entry.mediaRef) === selectedMediaKey);
  if (!media && !selectedMediaKey && !record.mediaStatus)
    return record.trace ? (
      <ExplorationTrace trace={record.trace} sideLabel={sideLabel} bounds={traceBounds} />
    ) : (
      <p className="exploration-media-missing">
        <ExplorationIcon kind="code" />
        本条记录没有可用图片或回放，下方直接呈现实际输入与输出。
      </p>
    );
  const label = [sideLabel, record.label, media?.label ?? '所选原件'].filter(Boolean).join(' · ');
  const src = media ? mediaUrl(programId, record, media) : '';
  const image = record.media.find((item) => item.kind === 'image' && item.timeRange?.startSeconds === 0);
  return (
    <figure className="exploration-media" data-media-record={refIdentity(record.recordRef)}>
      <figcaption>
        <ExplorationIcon kind="evidence" />
        <strong>{label}</strong>
        {media && <span>{media.provenance === 'original' ? '真实原件' : '相同 capture 的确定性回放'}</span>}
      </figcaption>
      {record.mediaStatus || !media ? (
        <div className="exploration-media-message" role="status">
          <p>{record.mediaStatus?.reason ?? '所看的原件已不在当前来源列表。请选择其它原件或重新核对来源。'}</p>
          <button type="button" onClick={onRetry}>
            重新核对原件
          </button>
        </div>
      ) : media.kind === 'video' ? (
        <VideoEvidence
          key={refIdentity(media.mediaRef)}
          src={src}
          label={label}
          poster={image ? mediaUrl(programId, record, image) : undefined}
        />
      ) : (
        <ImageEvidence key={refIdentity(media.mediaRef)} src={src} label={label} />
      )}
      {(record.media.length > 1 || (!media && record.media.length > 0)) && (
        <div className="exploration-media-choices" role="group" aria-label="本条记录的原件">
          {record.media.map((entry) => (
            <button
              key={refIdentity(entry.mediaRef)}
              type="button"
              aria-pressed={entry === media}
              onClick={() => setSelectedMediaKey(refIdentity(entry.mediaRef))}
            >
              {entry.label}
            </button>
          ))}
        </div>
      )}
      {media && (
        <p className="exploration-caption">
          保留原始时间与完整片段。{media.timeRange ? ` 此帧位于 ${media.timeRange.startSeconds} s。` : ''}
        </p>
      )}
      {record.trace && (
        <details open={!media}>
          <summary>查看同次实际轨迹</summary>
          <ExplorationTrace trace={record.trace} sideLabel={sideLabel} bounds={traceBounds} />
        </details>
      )}
    </figure>
  );
}
