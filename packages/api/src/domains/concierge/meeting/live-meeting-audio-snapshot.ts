import { z } from 'zod';
import type { MeetingCapture } from './live-meeting-control-contract.js';

const snapshot = z.object({
  running: z.boolean(),
  lifecycle_state: z.enum(['starting', 'running', 'finalizing', 'stopped']).optional(),
  controller_lease: z.unknown().optional(),
  paused: z.boolean().optional().default(false),
  thread_id: z.string().nullable().optional(),
  meeting_id: z.string().nullable().optional(),
  started_at: z.number().finite().nullable().optional(),
  chunk_count: z.number().int().nonnegative().optional().default(0),
  health: z.object({ asr: z.object({ state: z.string().max(64) }).optional() }).optional(),
  inputs: z
    .array(
      z.object({
        id: z.string().max(128),
        source: z.enum(['app', 'mic']),
        label: z.string().max(256),
        state: z.string().max(64),
        app_name: z.string().max(256).optional(),
        signal: z
          .object({
            state: z.string().max(64),
            pcm_bytes: z.number().nonnegative(),
            peak_abs: z.number().nonnegative(),
          })
          .optional(),
      }),
    )
    .max(8)
    .optional()
    .default([]),
});

export function meetingAudioSnapshot(value: unknown): MeetingCapture | null {
  const parsed = snapshot.safeParse(value);
  if (!parsed.success) return null;
  const s = parsed.data;
  if (s.running && (!s.thread_id || !s.meeting_id || !s.started_at || s.started_at <= 0)) return null;
  return {
    running: s.running,
    lifecycle:
      s.lifecycle_state === 'stopped'
        ? s.controller_lease === null
          ? 'stopped'
          : 'unknown'
        : (s.lifecycle_state ?? 'unknown'),
    paused: s.paused,
    threadId: s.thread_id ?? '',
    meetingId: s.meeting_id ?? '',
    startedAt: s.started_at ?? 0,
    chunks: s.chunk_count,
    asrState: s.health?.asr?.state ?? 'unknown',
    inputs: s.inputs.map((i) => ({
      id: i.id,
      source: i.source,
      label: i.label,
      state: i.state,
      ...(i.app_name !== undefined ? { appName: i.app_name } : {}),
      ...(i.signal
        ? { signal: { state: i.signal.state, pcmBytes: i.signal.pcm_bytes, peakAbs: i.signal.peak_abs } }
        : {}),
    })),
  };
}
