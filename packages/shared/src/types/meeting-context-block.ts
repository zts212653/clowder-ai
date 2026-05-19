export type MeetingContextProvenance = 'transcript' | 'user_note' | 'system_event';

export interface MeetingContextBlock {
  type: 'meeting_context';
  meetingId: string;
  provenance: MeetingContextProvenance;
  speakerId?: string;
  speakerLabel: string;
  speakerConfidence: number;
  timestamp: number;
  content: string;
}

const SPEAKER_CONFIDENCE_THRESHOLD = 0.6;
const DEGRADED_LABEL = '有人说';

const CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;
const INJECTION_TOKEN_RE = /<\|[^|]*\|>/g;

function sanitizeContent(raw: string): string {
  return raw.replace(CONTROL_CHAR_RE, '').replace(INJECTION_TOKEN_RE, '');
}

export function createMeetingContextBlock(input: {
  meetingId: string;
  speakerId?: string;
  speakerLabel: string;
  speakerConfidence: number;
  timestamp: number;
  content: string;
  provenance?: MeetingContextProvenance;
}): MeetingContextBlock {
  const sanitized = sanitizeContent(input.content);
  if (!sanitized) throw new Error('content is required (empty after sanitization)');

  const confidence = Math.max(0, Math.min(1, input.speakerConfidence));
  const label = confidence < SPEAKER_CONFIDENCE_THRESHOLD ? DEGRADED_LABEL : input.speakerLabel;

  return {
    type: 'meeting_context',
    meetingId: input.meetingId,
    provenance: input.provenance ?? 'transcript',
    speakerId: input.speakerId,
    speakerLabel: label,
    speakerConfidence: confidence,
    timestamp: input.timestamp,
    content: sanitized,
  };
}
