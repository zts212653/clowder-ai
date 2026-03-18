import type { StudyArtifact } from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getPlaybackManager } from '@/hooks/useVoiceStream';
import { apiFetch } from '@/utils/api-client';
import { fetchPodcastScript, generatePodcast, type PodcastScript, type PodcastSegment } from '@/utils/signals-api';

interface PodcastPlayerProps {
  readonly articleId: string;
  readonly podcasts: readonly StudyArtifact[];
  readonly onArtifactCreated?: () => void;
}

const SPEAKER_COLORS: Record<string, string> = {
  宪宪: 'text-opus-dark bg-opus-bg',
  砚砚: 'text-emerald-700 bg-emerald-50',
  host: 'text-opus-dark bg-opus-bg',
  guest: 'text-emerald-700 bg-emerald-50',
};

function speakerStyle(speaker: string): string {
  return SPEAKER_COLORS[speaker] ?? SPEAKER_COLORS[speaker.toLowerCase()] ?? 'text-gray-700 bg-gray-100';
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Download a single segment's audio as a file. */
async function downloadSegmentAudio(audioUrl: string, speaker: string, index: number): Promise<void> {
  const res = await apiFetch(audioUrl);
  if (!res.ok) return;
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `podcast-${speaker}-${index + 1}.wav`;
  a.click();
  URL.revokeObjectURL(url);
}

function usePodcastPlayback(segments: readonly PodcastSegment[]) {
  const [playing, setPlaying] = useState(false);
  const [currentIdx, setCurrentIdx] = useState(-1);
  const unsubsRef = useRef<Array<() => void>>([]);
  const runIdRef = useRef(0);

  const cleanup = useCallback(() => {
    for (const unsub of unsubsRef.current) unsub();
    unsubsRef.current = [];
  }, []);

  useEffect(() => cleanup, [cleanup]);

  const playAll = useCallback(async () => {
    const manager = getPlaybackManager();
    if (playing) {
      manager.interrupt();
      cleanup();
      setPlaying(false);
      setCurrentIdx(-1);
      return;
    }

    const urls = segments.map((s) => s.audioUrl).filter((u): u is string => Boolean(u));
    if (urls.length === 0) return;

    const thisRunId = ++runIdRef.current;
    cleanup();
    setPlaying(true);
    setCurrentIdx(0);

    unsubsRef.current.push(
      manager.onItemEnd((index) => {
        setCurrentIdx(index + 1 < segments.length ? index + 1 : -1);
      }),
    );
    unsubsRef.current.push(
      manager.onStateIdle(() => {
        cleanup();
        setPlaying(false);
        setCurrentIdx(-1);
      }),
    );

    try {
      await manager.startBatch(urls, apiFetch);
    } catch {
      if (runIdRef.current === thisRunId) manager.interrupt();
    } finally {
      if (runIdRef.current === thisRunId && manager.getState() === 'idle') {
        cleanup();
        setPlaying(false);
        setCurrentIdx(-1);
      }
    }
  }, [segments, playing, cleanup]);

  const playSingle = useCallback(
    (seg: PodcastSegment, index: number) => {
      if (!seg.audioUrl) return;
      const manager = getPlaybackManager();

      if (currentIdx === index && playing) {
        manager.interrupt();
        cleanup();
        setPlaying(false);
        setCurrentIdx(-1);
        return;
      }

      const thisRunId = ++runIdRef.current;
      manager.interrupt();
      cleanup();
      setPlaying(true);
      setCurrentIdx(index);

      unsubsRef.current.push(
        manager.onStateIdle(() => {
          cleanup();
          setPlaying(false);
          setCurrentIdx(-1);
        }),
      );

      void manager
        .enqueueUrl(seg.audioUrl, apiFetch)
        .then(() => {
          if (runIdRef.current !== thisRunId) return;
          manager.markDone();
          if (manager.getState() === 'idle') {
            cleanup();
            setPlaying(false);
            setCurrentIdx(-1);
          }
        })
        .catch(() => {
          if (runIdRef.current !== thisRunId) return;
          manager.interrupt();
          cleanup();
          setPlaying(false);
          setCurrentIdx(-1);
        });
    },
    [currentIdx, playing, cleanup],
  );

  return { playAll, playSingle, playingAll: playing, currentPlayIdx: currentIdx };
}

export function PodcastPlayer({ articleId, podcasts, onArtifactCreated }: PodcastPlayerProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [script, setScript] = useState<PodcastScript | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [activeSegment, setActiveSegment] = useState(-1);

  const readyPodcasts = podcasts.filter((p) => p.state === 'ready');
  const pendingPodcasts = podcasts.filter((p) => p.state === 'queued' || p.state === 'running');

  const loadScript = useCallback(
    async (artifactId: string) => {
      setLoading(true);
      setError(null);
      setScript(null);
      setActiveSegment(-1);
      try {
        const result = await fetchPodcastScript(articleId, artifactId);
        setScript(result.script);
        setSelectedId(artifactId);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load script');
      } finally {
        setLoading(false);
      }
    },
    [articleId],
  );

  const handleGenerate = useCallback(
    async (mode: 'essence' | 'deep') => {
      setGenerating(true);
      setError(null);
      try {
        await generatePodcast(articleId, mode);
        onArtifactCreated?.();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to generate');
      } finally {
        setGenerating(false);
      }
    },
    [articleId, onArtifactCreated],
  );

  // Reset state when articleId changes
  useEffect(() => {
    getPlaybackManager().interrupt();
    setSelectedId(null);
    setScript(null);
    setError(null);
    setActiveSegment(-1);
  }, []);

  // Auto-load first ready podcast
  useEffect(() => {
    if (!selectedId && readyPodcasts.length > 0) {
      void loadScript(readyPodcasts[0].id);
    }
  }, [selectedId, readyPodcasts, loadScript]);

  const hasAudio = script?.segments.some((s) => s.audioUrl);
  const { playAll, playSingle, playingAll, currentPlayIdx } = usePodcastPlayback(script?.segments ?? []);

  return (
    <div className="mt-3">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-semibold text-gray-500">播客脚本</h4>
        <div className="flex gap-1">
          <button
            type="button"
            disabled={generating}
            onClick={() => void handleGenerate('essence')}
            className="rounded border border-opus-light px-2 py-0.5 text-[10px] text-opus-dark hover:bg-opus-bg disabled:opacity-50"
          >
            {generating ? '生成中...' : '精华版'}
          </button>
          <button
            type="button"
            disabled={generating}
            onClick={() => void handleGenerate('deep')}
            className="rounded border border-gray-300 px-2 py-0.5 text-[10px] text-gray-600 hover:bg-gray-100 disabled:opacity-50"
          >
            深度版
          </button>
        </div>
      </div>

      {pendingPodcasts.length > 0 && (
        <p className="mt-1 text-[10px] text-amber-600">{pendingPodcasts.length} 个播客正在生成中...</p>
      )}

      {readyPodcasts.length > 1 && (
        <div className="mt-1 flex gap-1">
          {readyPodcasts.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => void loadScript(p.id)}
              className={`rounded px-2 py-0.5 text-[10px] ${
                selectedId === p.id
                  ? 'bg-opus-primary text-white'
                  : 'border border-gray-200 text-gray-600 hover:bg-gray-50'
              }`}
            >
              {p.id.slice(0, 8)}
            </button>
          ))}
        </div>
      )}

      {error && <p className="mt-1 text-[10px] text-red-500">{error}</p>}
      {loading && <p className="mt-1 text-[10px] text-gray-400">加载中...</p>}

      {script && (
        <div className="mt-2 rounded-md border border-gray-200 bg-white">
          <div className="flex items-center justify-between border-b border-gray-100 px-3 py-1.5">
            <span className="text-[10px] text-gray-400">
              {script.mode === 'deep' ? '深度版' : '精华版'} · {script.segments.length} 段
            </span>
            <div className="flex items-center gap-2">
              {hasAudio && (
                <button
                  type="button"
                  onClick={() => void playAll()}
                  className="rounded px-1.5 py-0.5 text-[10px] text-opus-dark hover:bg-opus-bg"
                  title={playingAll ? '停止全部' : '连续播放'}
                >
                  {playingAll ? '⏹ 停止' : '▶ 全部播放'}
                </button>
              )}
              <span className="text-[10px] text-gray-400">约 {formatDuration(script.totalDuration)}</span>
            </div>
          </div>
          <div className="max-h-64 overflow-y-auto">
            {script.segments.map((seg, i) => (
              <div
                key={`${seg.speaker}-${i}`}
                className={`flex w-full items-start gap-2 px-3 py-2 text-left transition-colors ${
                  activeSegment === i ? 'bg-opus-bg' : 'hover:bg-gray-50'
                }`}
              >
                {seg.audioUrl ? (
                  <div className="mt-0.5 flex shrink-0 gap-1">
                    <button
                      type="button"
                      onClick={() => playSingle(seg, i)}
                      className={`text-[10px] hover:text-opus-primary ${
                        currentPlayIdx === i ? 'text-opus-primary' : 'text-opus-dark'
                      }`}
                      title={currentPlayIdx === i ? '暂停' : '播放'}
                    >
                      {currentPlayIdx === i ? '⏸' : '▶'}
                    </button>
                    <button
                      type="button"
                      onClick={() => seg.audioUrl && void downloadSegmentAudio(seg.audioUrl, seg.speaker, i)}
                      className="text-[10px] text-gray-400 hover:text-gray-600"
                      title="下载音频"
                    >
                      ⬇
                    </button>
                  </div>
                ) : null}
                <button
                  type="button"
                  onClick={() => setActiveSegment(activeSegment === i ? -1 : i)}
                  className="flex flex-1 items-start gap-2 text-left"
                >
                  <span
                    className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${speakerStyle(seg.speaker)}`}
                  >
                    {seg.speaker}
                  </span>
                  <span className="flex-1 text-xs text-gray-700">{seg.text}</span>
                </button>
                <span className="shrink-0 text-[10px] text-gray-300">{formatDuration(seg.durationEstimate)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {!script && !loading && readyPodcasts.length === 0 && !error && (
        <p className="mt-1 text-[10px] text-gray-400">还没有播客脚本，点击上方按钮生成。</p>
      )}
    </div>
  );
}
