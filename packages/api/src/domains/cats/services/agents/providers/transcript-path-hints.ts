import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderSegment } from '../../context/prompt-template-loader.js';

export interface TranscriptMeta {
  active: boolean;
  transcript_path: string;
  latest_range: string | null;
  participants: { id: string; name: string }[];
  meeting_id: string;
  thread_id: string;
}

export function readActiveTranscriptMeta(transcriptDir: string, threadId: string): TranscriptMeta | null {
  try {
    const raw = readFileSync(join(transcriptDir, threadId, 'meta.json'), 'utf-8');
    const meta: TranscriptMeta = JSON.parse(raw);
    if (!meta.active) return null;
    return meta;
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && (err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[transcript-path-hints] Failed to read meta.json for thread %s: %s', threadId, err);
    }
    return null;
  }
}

/**
 * Template: assets/prompt-templates/m2-transcript-hints.md
 */
export function buildTranscriptPathHints(meta: TranscriptMeta): string {
  const safe = (n: string) => n.replace(/[\n\r[\]]/g, '');
  const latestRangeLine = meta.latest_range ? `[Latest range: ${meta.latest_range}]` : '';
  const participantsLine =
    meta.participants.length > 0 ? `[Participants: ${meta.participants.map((p) => safe(p.name)).join(', ')}]` : '';

  return (
    renderSegment('M2', {
      TRANSCRIPT_PATH: meta.transcript_path,
      LATEST_RANGE_LINE: latestRangeLine,
      PARTICIPANTS_LINE: participantsLine,
    }) ?? ''
  );
}

export function appendTranscriptPathHints(prompt: string, transcriptDir: string, threadId: string): string {
  const meta = readActiveTranscriptMeta(transcriptDir, threadId);
  if (!meta) return prompt;
  return `${prompt}\n\n${buildTranscriptPathHints(meta)}`;
}
