'use client';

import { useShellCopy } from '@/components/shell/shell-copy';
import { AudioInputPicker } from './AudioInputPicker';
import type { AudioPanelError } from './audio-panel-error';
import type {
  AudioInputRequest,
  AudioSources,
  AudioStatus,
  Participant,
  TranscriptLine,
} from './audio-transcript-contract';
import { SavedPathsV2 } from './SavedPathsV2';
import { TranscriptCaptureHeader } from './TranscriptCaptureHeader';
import { TranscriptFooterV2 } from './TranscriptFooterV2';
import { TranscriptLinesV2 } from './TranscriptLinesV2';
import { voiceMeetingCopy } from './voice-meeting.shell-copy';

/**
 * §1.14 语音 2/3/4 — the v2 docked meeting panel: prepare (pickers + empty state), live (header controls, health
 * tags, per-line time/speaker/source with 更正说话人), stopped (saved paths with 在文件里打开/复制路径, 重新开始).
 */
export function TranscriptPanelV2({
  status,
  lines,
  connected,
  elapsed,
  savedPath,
  savedRecordingPath,
  savedRecordingPaths,
  savedResultOwner,
  sources,
  sourceError,
  startError,
  sourceLabel,
  hasSession,
  avgLatencySeconds,
  onStart,
  onPause,
  onResume,
  onStop,
  onStartAgain,
  onPopOut,
  onCorrect,
}: {
  status: AudioStatus;
  lines: TranscriptLine[];
  connected: boolean;
  elapsed: number;
  savedPath: string | null;
  savedRecordingPath: string | null;
  savedRecordingPaths: Record<string, string>;
  /** The capture session that owns the displayed stopped result (producer identity — R4-P1a). */
  savedResultOwner: string | null;
  sources: AudioSources | null;
  sourceError: AudioPanelError | null;
  startError: AudioPanelError | null;
  sourceLabel: string;
  hasSession: boolean;
  avgLatencySeconds: string | null;
  onStart: (inputs: AudioInputRequest[]) => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onStartAgain: () => void;
  onPopOut: () => void;
  onCorrect: (chunkNum: number, speakerId: string, speakerLabel: string) => void;
}) {
  const t = useShellCopy(voiceMeetingCopy);
  const inputLabels: Record<string, string> = {};
  for (const input of status.inputs ?? []) inputLabels[input.id] = input.label ?? input.id;
  const errorText = (error: AudioPanelError): string => {
    if (error.kind === 'sources-unavailable') return t.capture.sourcesUnavailable;
    if (error.kind === 'service-offline') return t.capture.serviceOffline;
    if (error.kind === 'open-thread-first') return t.capture.openThreadFirst;
    return error.reason ? t.capture.startError(error.reason) : t.capture.startFailedGeneric;
  };

  return (
    <div className="flex h-full min-w-0 w-full flex-col bg-cafe-surface-primary">
      <TranscriptCaptureHeader
        status={status}
        sourceLabel={sourceLabel}
        elapsed={elapsed}
        hasSession={hasSession}
        onResume={onResume}
        onPause={onPause}
        onStop={onStop}
        onStartAgain={onStartAgain}
        onPopOut={onPopOut}
      />

      {!status.running && !hasSession && (
        <div className="border-b border-cafe-border px-3 py-2.5">
          {sourceError ? (
            <p className="text-xs text-conn-red-text">{errorText(sourceError)}</p>
          ) : sources ? (
            <AudioInputPicker sources={sources} onStart={onStart} />
          ) : (
            <p className="text-xs text-cafe-text-muted">{t.capture.loadingSources}</p>
          )}
          {startError && <p className="mt-1.5 text-xs text-conn-red-text">{errorText(startError)}</p>}
        </div>
      )}

      <TranscriptLinesV2
        lines={lines}
        waiting={status.running}
        emptyText={t.capture.empty}
        waitingText={t.capture.waiting}
        participants={status.participants as Participant[] | undefined}
        onCorrect={onCorrect}
      />

      {!status.running && hasSession && (
        <SavedPathsV2
          savedPath={savedPath}
          savedRecordingPath={savedRecordingPath}
          savedRecordingPaths={savedRecordingPaths}
          ownerThreadId={savedResultOwner}
          inputLabels={inputLabels}
        />
      )}

      <TranscriptFooterV2 lineCount={lines.length} avgLatencySeconds={avgLatencySeconds} connected={connected} />
    </div>
  );
}
