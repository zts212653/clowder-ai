import { z } from 'zod';

const targetSchema = z
  .object({
    thread_id: z.string().min(1).max(128),
    meeting_id: z.string().min(1),
    started_at: z.number().finite().positive(),
  })
  .strict();

export type AudioCaptureTarget = z.infer<typeof targetSchema>;
export function readAudioCaptureTarget(value: unknown): AudioCaptureTarget | null {
  const parsed = targetSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
export function matchesAudioCaptureTarget(a: AudioCaptureTarget | null, b: AudioCaptureTarget): boolean {
  return Boolean(a && a.thread_id === b.thread_id && a.meeting_id === b.meeting_id && a.started_at === b.started_at);
}

export function audioCaptureTargetFromStatus(value: unknown): AudioCaptureTarget | null {
  const parsed = targetSchema.passthrough().safeParse(value);
  if (!parsed.success) return null;
  return { thread_id: parsed.data.thread_id, meeting_id: parsed.data.meeting_id, started_at: parsed.data.started_at };
}

export function guardedAudioStopError(body: Record<string, unknown> | null, actual: AudioCaptureTarget | null) {
  if (!body || !Object.hasOwn(body, 'expected_capture')) return null;
  const expected = readAudioCaptureTarget(body.expected_capture);
  if (!expected) return { status: 400, error: 'Exact capture target required' };
  if (!matchesAudioCaptureTarget(actual, expected))
    return { status: 409, error: 'Audio capture target changed or is not owned by this controller' };
  return null;
}
