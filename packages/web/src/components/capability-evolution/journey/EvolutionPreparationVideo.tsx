'use client';

import type { EvolutionPreparationMediaV1 } from '@cat-cafe/shared';
import { useState } from 'react';

type PlaybackState = 'idle' | 'loading' | 'ready' | 'failed';

export function EvolutionPreparationVideo({
  programId,
  label,
  media,
}: {
  programId: string;
  label: string;
  media: EvolutionPreparationMediaV1;
}) {
  const [state, setState] = useState<PlaybackState>('idle');
  const [attempt, setAttempt] = useState(0);
  const open = () => {
    setAttempt((value) => value + 1);
    setState('loading');
  };
  if (state === 'idle' || state === 'failed')
    return (
      <div className="evolution-preparation-video mt-3" data-playback-state={state}>
        {state === 'failed' && <p className="evolution-empty">回放加载失败；材料说明仍可阅读。</p>}
        <button type="button" className="evolution-link mt-1" onClick={open}>
          {state === 'failed' ? `重试：${label}` : `在页面内播放：${label}`}
        </button>
        {media.durationSeconds && <span className="ml-2 text-xs text-cafe-muted">约 {media.durationSeconds} 秒</span>}
      </div>
    );
  const sha256 = media.mediaRef.version as string;
  return (
    <div className="evolution-preparation-video mt-3" data-playback-state={state}>
      {state === 'loading' && <p className="evolution-empty mb-2">正在加载回放…</p>}
      <video
        key={attempt}
        aria-label={label}
        className="evolution-preparation-video-player"
        controls
        muted
        playsInline
        preload="metadata"
        src={`/api/capability-evolution/programs/${encodeURIComponent(programId)}/preparation-media/${sha256}`}
        onLoadedMetadata={() => setState('ready')}
        onCanPlay={() => setState('ready')}
        onError={() => setState('failed')}
      />
    </div>
  );
}
