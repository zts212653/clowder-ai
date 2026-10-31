import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { z } from 'zod';
import { whileNotAborted } from '../domains/concierge/live/host/live-controlled-context.js';
import { LiveMeetingAudioError } from '../domains/concierge/meeting/live-meeting-audio-error.js';
import { meetingAudioSnapshot } from '../domains/concierge/meeting/live-meeting-audio-snapshot.js';
import type { LiveMeetingAudioPort } from '../domains/concierge/meeting/live-meeting-control-contract.js';
import { AUDIO_MUTATION_TIMEOUT_MS, AUDIO_REQUEST_TIMEOUT_MS } from './audio-request-deadline.js';

/** Internal bounded caller of the existing controller, not a sidecar client or a second lease owner. */
export function createF317MeetingAudioPort(
  app: FastifyInstance,
  ownerUserId: string,
  options: { requestTimeoutMs?: number } = {},
): LiveMeetingAudioPort {
  const request = async (path: string, body?: Record<string, unknown>) => {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      options.requestTimeoutMs ?? (body ? AUDIO_MUTATION_TIMEOUT_MS : AUDIO_REQUEST_TIMEOUT_MS) + 2_000,
    );
    let response: LightMyRequestResponse;
    try {
      response = await whileNotAborted(
        controller.signal,
        app.inject({
          method: body ? 'POST' : 'GET',
          url: `/api/audio/${path}`,
          headers: { 'x-cat-cafe-user': ownerUserId },
          signal: controller.signal,
          ...(body ? { payload: body } : {}),
        }),
      );
    } catch (error) {
      if (controller.signal.aborted)
        throw new LiveMeetingAudioError(504, path, 'Audio controller request deadline exceeded');
      throw error;
    } finally {
      clearTimeout(timer);
    }
    if (response.statusCode >= 400) {
      const parsed = z.object({ error: z.string().max(1000) }).safeParse(response.json<unknown>());
      throw new LiveMeetingAudioError(
        response.statusCode,
        path,
        parsed.success ? parsed.data.error : 'Controller request rejected',
      );
    }
    return response.json<unknown>();
  };
  const capture = (value: unknown) => {
    const parsed = meetingAudioSnapshot(value);
    if (!parsed) throw new Error('meeting_audio_snapshot_invalid');
    return parsed;
  };
  return {
    sources: async () => {
      const parsed = z
        .object({
          apps: z.array(z.object({ id: z.string().min(1).max(256), name: z.string().min(1).max(256) })).max(128),
        })
        .parse(await request('sources'));
      if (new Set(parsed.apps.map((a) => a.id)).size !== parsed.apps.length)
        throw new Error('meeting_audio_catalog_ambiguous');
      return parsed.apps;
    },
    status: async () => {
      try {
        return capture(await request('status'));
      } catch {
        return null;
      }
    },
    start: async ({ threadId, meetingId, source }) => {
      const value = z.object({ status: z.unknown() }).parse(
        await request('start', {
          thread_id: threadId,
          meeting_id: meetingId,
          inputs: [{ id: 'primary', source: 'app', app_name: source.id, label: source.name }],
        }),
      );
      return capture(value.status);
    },
    stop: async (target) => {
      await request('stop', {
        expected_capture: {
          thread_id: target.threadId,
          meeting_id: target.meetingId,
          started_at: target.startedAt,
        },
      });
    },
  };
}
