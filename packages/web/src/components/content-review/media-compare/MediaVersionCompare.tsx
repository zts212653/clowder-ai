'use client';
import Image from 'next/image';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import styles from './media-compare.module.css';
import { type CompareMediaVersion, compareMediaKey, useCompareMediaSources } from './useCompareMediaSources';
import { useComparePlayback } from './useComparePlayback';

type Props = {
  original: CompareMediaVersion;
  candidate: CompareMediaVersion;
  onUnavailable?: () => void;
  decision?: ReactNode;
  fallback?: ReactNode;
};
export function MediaVersionCompare(props: Props) {
  return <CompareSession key={compareMediaKey([props.original, props.candidate])} {...props} />;
}
function CompareSession({ original, candidate, onUnavailable, decision, fallback }: Props) {
  const versions = [original, candidate];
  const stage = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0),
    [chosenMode, setMode] = useState<'side' | 'toggle' | null>(null);
  const [height, setHeight] = useState(0),
    [muted, setMuted] = useState(true);
  const [selected, setSelected] = useState(1),
    [zoom, setZoom] = useState('fit');
  const [decodeError, setDecodeError] = useState<string | null>(null);
  const source = useCompareMediaSources(versions, onUnavailable);
  const playback = useComparePlayback(versions.map((version) => version.asset.media));
  const video = versions.every((version) => version.asset.media.kind === 'video');
  const compatible = versions.every((version) => version.asset.mediaType === original.asset.mediaType);
  const comparisonError = !compatible ? '两版媒体类型不同，无法对比。' : (source.error ?? decodeError);
  const fitsSide = width >= 640 && versions.every((version) => version.asset.media.width <= (width - 16) / 2);
  const mode = width < 640 ? 'toggle' : (chosenMode ?? (fitsSide ? 'side' : 'toggle'));
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      setWidth(entry.contentRect.width);
      setHeight(entry.contentRect.height);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <section className={styles.compare} aria-label="版本对比" data-compare-mode={mode}>
      <div className={styles.controls}>
        <div role="group" aria-label="对比方式">
          <button type="button" aria-pressed={mode === 'side'} disabled={width < 640} onClick={() => setMode('side')}>
            并排
          </button>
          <button type="button" aria-pressed={mode === 'toggle'} onClick={() => setMode('toggle')}>
            切换
          </button>
        </div>
        {mode === 'toggle' ? (
          <div role="group" aria-label="显示版本">
            {versions.map((version, index) => (
              <button key={index} type="button" aria-pressed={selected === index} onClick={() => setSelected(index)}>
                {version.label} · v{version.asset.ownerRevision}
              </button>
            ))}
          </div>
        ) : null}
        <label>
          显示比例{' '}
          <select aria-label="对比显示比例" value={zoom} onChange={(event) => setZoom(event.target.value)}>
            <option value="fit">适应窗口</option>
            <option value="native">100%</option>
          </select>
        </label>
      </div>
      <div ref={stage} className={styles.viewport} data-testid="media-compare-viewport">
        {comparisonError ? (
          <>
            <p role="alert">{fallback ? '两版暂无法核对；以下仍可查看候选版本。' : comparisonError}</p>
            {fallback}
          </>
        ) : !source.sources.length ? (
          <>
            <p role="status">正在读取两版作品…</p>
            {fallback}
          </>
        ) : (
          <div className={styles.panes} data-layout={mode} data-zoom={zoom}>
            {versions.map((version, index) => (
              <figure
                key={index}
                className={styles.pane}
                hidden={mode === 'toggle' && selected !== index}
                aria-label={index === 0 ? '原版' : '候选版本'}
              >
                <figcaption>
                  {version.label} · v{version.asset.ownerRevision} · {version.asset.media.width} ×{' '}
                  {version.asset.media.height}
                </figcaption>
                <div
                  className={styles.media}
                  style={{
                    width:
                      zoom === 'native'
                        ? version.asset.media.width
                        : Math.min(
                            version.asset.media.width,
                            mode === 'side' ? (width - 16) / 2 : width,
                            height > 80 &&
                              (version.asset.media.kind !== 'image' ||
                                version.asset.media.height <= version.asset.media.width)
                              ? ((height - 80) * version.asset.media.width) / version.asset.media.height
                              : version.asset.media.width,
                          ) || undefined,
                    maxWidth: version.asset.media.width,
                  }}
                >
                  {version.asset.mediaType === 'image/png' ? (
                    <Image
                      unoptimized
                      src={source.sources[index]}
                      width={version.asset.media.width}
                      height={version.asset.media.height}
                      alt={`${version.label} v${version.asset.ownerRevision}`}
                      onError={() => setDecodeError('图片当前无法显示，候选仍保留。')}
                    />
                  ) : (
                    <video
                      ref={playback.refs[index]}
                      src={source.sources[index]}
                      muted={muted || index !== selected}
                      playsInline
                      preload="auto"
                      aria-label={`${version.label} v${version.asset.ownerRevision}`}
                      onLoadedMetadata={() => playback.loaded(index)}
                      onTimeUpdate={() => playback.timeUpdate(index)}
                      onEnded={() => playback.ended(index)}
                      onError={() => {
                        playback.failed();
                        setDecodeError('视频当前无法显示。');
                      }}
                    />
                  )}
                </div>
                <details className={styles.details}>
                  <summary>版本详情</summary>
                  <dl>
                    <dt>版本引用</dt>
                    <dd>
                      {version.asset.contentRef} · v{version.asset.ownerRevision}
                    </dd>
                    <dt>媒体摘要</dt>
                    <dd>{version.asset.blobDigest}</dd>
                    <dt>版本回执</dt>
                    <dd>{version.asset.ownerReceiptRef}</dd>
                  </dl>
                </details>
              </figure>
            ))}
          </div>
        )}
      </div>
      {video && source.sources.length && !comparisonError ? (
        <div className={styles.playback}>
          <button type="button" disabled={!playback.ready} onClick={() => void playback.play()}>
            {playback.playing ? '暂停两版' : '同步播放'}
          </button>
          <button type="button" onClick={() => setMuted(!muted)}>
            {muted ? '开启声音' : '静音'}
          </button>
          <input
            type="range"
            aria-label="对比播放位置"
            min={0}
            max={playback.duration}
            step="0.01"
            value={playback.seconds}
            disabled={!playback.ready}
            onChange={(event) => playback.seek(Number(event.target.value))}
          />
          <output>
            {playback.seconds.toFixed(2)} / {playback.duration.toFixed(2)} 秒
          </output>
          {playback.differentLengths ? <p>按各版本起点对齐；较短版本到末尾后停留。</p> : null}
          {playback.error ? <p role="alert">{playback.error}</p> : null}
        </div>
      ) : null}
      {decision ? <div className={styles.decision}>{decision}</div> : null}
    </section>
  );
}
