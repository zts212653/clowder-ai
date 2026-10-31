import type { TranscriptLine } from './audio-transcript-contract';

/**
 * Panel-facing failure as a semantic state, not a sentence: the classic views map each kind to the exact English they
 * have always shown, the v2 views map it to the current dictionary language — so an already-visible error follows a
 * language switch without remounting (review P2-4). Server-provided error text stays raw data in both.
 */
export type AudioPanelError =
  | { kind: 'sources-unavailable' }
  | { kind: 'service-offline' }
  | { kind: 'open-thread-first' }
  | { kind: 'start-failed'; reason?: string };

export function classicAudioPanelErrorText(error: AudioPanelError): string {
  if (error.kind === 'sources-unavailable') return 'Audio sources are unavailable.';
  if (error.kind === 'service-offline') return 'Audio service is offline.';
  if (error.kind === 'open-thread-first') return 'Open a thread before starting companion audio.';
  return error.reason ?? 'Audio capture could not start.';
}

/** Live average ASR latency: derived from the actual transcript lines (review P2-5). */
export function linesAvgLatency(lines: TranscriptLine[]): string | null {
  if (!lines.length) return null;
  return (lines.reduce((sum, line) => sum + line.asr_latency, 0) / lines.length).toFixed(2);
}
