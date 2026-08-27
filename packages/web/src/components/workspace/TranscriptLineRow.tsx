import type { TranscriptLine } from './audio-transcript-contract';

function formatTime(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString('zh-CN', { hour12: false });
}

/** Read-only transcript row for the docked panel. */
export function TranscriptLineRow({ line }: { line: TranscriptLine }) {
  return (
    <div className="mb-1 flex gap-2">
      <span className="shrink-0 text-cafe-text-muted">[{formatTime(line.ts)}]</span>
      {line.speaker_label && (
        <span className="shrink-0 font-medium text-cafe-accent-primary">{line.speaker_label}:</span>
      )}
      {line.input_label && (
        <span className="shrink-0 rounded bg-cafe-surface-secondary px-1 text-cafe-text-muted">{line.input_label}</span>
      )}
      <span className="text-cafe-text-primary">{line.text}</span>
    </div>
  );
}
