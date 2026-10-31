'use client';

import { AudioInputPicker } from './AudioInputPicker';
import type { AudioPanelError } from './audio-panel-error';
import { classicAudioPanelErrorText } from './audio-panel-error';
import type { AudioInputRequest, AudioSources, AudioStatus, TranscriptLine } from './audio-transcript-contract';
import { TranscriptCaptureHeader } from './TranscriptCaptureHeader';
import { TranscriptLineRow } from './TranscriptLineRow';

/** The classic docked transcript panel view, unchanged from before the v2 branch existed. */
export function TranscriptPanelClassicView({
  status,
  lines,
  connected,
  elapsed,
  savedPath,
  savedRecordingPath,
  savedRecordingPaths,
  sources,
  sourceError,
  startError,
  scrollRef,
  onScrollBody,
  sourceLabel,
  avgLatency,
  onStart,
  onPause,
  onResume,
  onStop,
  onPopOut,
}: {
  status: AudioStatus;
  lines: TranscriptLine[];
  connected: boolean;
  elapsed: number;
  savedPath: string | null;
  savedRecordingPath: string | null;
  savedRecordingPaths: Record<string, string>;
  sources: AudioSources | null;
  sourceError: AudioPanelError | null;
  startError: AudioPanelError | null;
  scrollRef: React.Ref<HTMLDivElement>;
  onScrollBody: () => void;
  sourceLabel: string;
  avgLatency: string;
  onStart: (inputs: AudioInputRequest[]) => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onPopOut: () => void;
}) {
  return (
    <div className="flex h-full min-w-0 w-full flex-col bg-cafe-surface-primary">
      <TranscriptCaptureHeader
        status={status}
        sourceLabel={sourceLabel}
        elapsed={elapsed}
        onResume={onResume}
        onPause={onPause}
        onStop={onStop}
        onPopOut={onPopOut}
      />

      {!status.running && (
        <div className="border-b border-cafe-border bg-cafe-surface-secondary px-3 py-2 space-y-2">
          {sourceError ? (
            <p className="text-xs text-conn-red-text">{classicAudioPanelErrorText(sourceError)}</p>
          ) : sources ? (
            <AudioInputPicker sources={sources} onStart={onStart} />
          ) : (
            <p className="text-xs text-cafe-text-muted">Loading audio sources…</p>
          )}
          {startError && <p className="text-xs text-conn-red-text">{classicAudioPanelErrorText(startError)}</p>}
        </div>
      )}

      {/* Transcript body */}
      <div ref={scrollRef} onScroll={onScrollBody} className="flex-1 overflow-y-auto px-3 py-2 font-mono text-xs">
        {lines.length === 0 && (
          <p className="mt-8 text-center text-cafe-text-muted">
            {status.running
              ? 'Waiting for first transcript chunk...'
              : 'No transcript data. Start audio capture to begin.'}
          </p>
        )}
        {lines.map((l, i) => (
          <TranscriptLineRow key={l.chunk_num ?? i} line={l} />
        ))}
      </div>

      {/* Saved paths */}
      {!status.running && (savedPath || savedRecordingPath || Object.keys(savedRecordingPaths).length > 0) && (
        <div className="border-t border-cafe-border px-3 py-1.5 text-xs text-cafe-text-secondary space-y-0.5">
          {savedPath && <div>Transcript: {savedPath}</div>}
          {savedRecordingPath && <div>Recording: {savedRecordingPath}</div>}
          {!savedRecordingPath &&
            Object.entries(savedRecordingPaths).map(([inputId, path]) => (
              <div key={inputId}>
                Recording ({inputId}): {path}
              </div>
            ))}
        </div>
      )}

      {/* Footer stats */}
      <div className="flex items-center gap-3 border-t border-cafe-border px-3 py-1.5 text-micro text-cafe-text-muted">
        <span>{lines.length} chunks</span>
        <span>avg {avgLatency}s</span>
        <span>16kHz mono</span>
        <span className={connected ? 'text-conn-emerald-text' : 'text-conn-red-text'}>
          {connected ? 'SSE' : 'disconnected'}
        </span>
      </div>
    </div>
  );
}
