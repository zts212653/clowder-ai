import { z } from 'zod';
import { defineMcpCanonicalFactory } from '../tool-governance-migration.js';
import { callbackPost } from './callback-tools.js';

const define = defineMcpCanonicalFactory('live-meeting-tools.ts', undefined, {
  resourceFamily: 'live-meeting',
  authority: 'callback-owner-private',
});
const readTransport = { fetchTimeoutMs: 15_000, enableOutbox: false, retryDelaysMs: [] };
const mutationTransport = { fetchTimeoutMs: 130_000, enableOutbox: false, retryDelaysMs: [] };
export const handleLiveMeetingSources = async () => callbackPost('/api/callbacks/meeting-sources', {}, readTransport);
export const handleLiveMeetingStatus = async () => callbackPost('/api/callbacks/meeting-status', {}, readTransport);
type SourceRequest = { requestMessageId?: string; sourceId: string };
export const handleLiveMeetingStart = async (input: SourceRequest) =>
  callbackPost('/api/callbacks/meeting-start', { ...input, mode: 'start' }, mutationTransport);
export const handleLiveMeetingAttach = async (input: SourceRequest) =>
  callbackPost('/api/callbacks/meeting-start', { ...input, mode: 'attach' }, mutationTransport);
export const handleLiveMeetingStop = async (input: { requestMessageId?: string; meetingId?: string }) =>
  callbackPost('/api/callbacks/meeting-stop', input, mutationTransport);

const governance = (implementationExport: string, action: string, write = false) => ({
  implementationExport,
  action,
  risk: { level: write ? ('write' as const) : ('read' as const), openWorld: false },
  runtimeProfiles: ['full', 'desktop:live-companion'] as const,
  standaloneReason: {
    disposition: 'accepted-boundary' as const,
    kind: 'resource-entry' as const,
    admissionRef: 'architecture-cell:live-meeting' as const,
  },
});
const requestMessageId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,160}$/)
  .optional()
  .describe(
    'Optional exact current direct owner source ID. Omit to let Host resolve its current persisted owner input; Host always reads the complete utterance.',
  );
const sourceId = z
  .string()
  .min(1)
  .max(256)
  .describe('Exact opaque App ID from meeting_sources; preserve bundle#pid=N verbatim.');
export const liveMeetingTools = [
  define({
    name: 'cat_cafe_meeting_sources',
    inputSchema: {},
    handler: handleLiveMeetingSources,
    description:
      'Discover available App audio sources for the current owner Live call. Use when: owner asks to listen to a meeting and the source must be identified. NOT for: starting capture, selecting a microphone, joining a meeting platform, or reading old recordings. Output: bounded App names and opaque catalog IDs only; no recording starts. Multiple instances require an explicit unique source; never pick first.',
    governance: governance('handleLiveMeetingSources', 'discover'),
  }),
  define({
    name: 'cat_cafe_meeting_start',
    handler: handleLiveMeetingStart,
    inputSchema: {
      requestMessageId,
      sourceId,
    },
    description:
      'Start a new single-App F195 recording/transcription. Use when: current owner says 开始听 Chrome / could you start listening to Google Chrome, or 开始录音 Chrome / start recording Google Chrome. An explicit listen request also admits transcript to this private call; record/transcribe alone does not share it (use meeting_attach on a later explicit request). NOT for: attaching existing transcript, vague 这场会议, how-to questions/conditions/negation, joining a platform, historical records, microphone/system/multi-source capture, or external sharing. Output: recording with accurate sharing/status, or needs_source/error without widening capture. Only Host-stored current human input grants permission; model text is not consent. running/ASR ready is not speech success.',
    governance: governance('handleLiveMeetingStart', 'start', true),
  }),
  define({
    name: 'cat_cafe_meeting_attach',
    handler: handleLiveMeetingAttach,
    inputSchema: { requestMessageId, sourceId },
    description:
      'Attach one explicitly named App’s existing active F195 transcript to the current private Live call. Use when: owner says 接入已有转写 Chrome / attach transcript from Google Chrome. NOT for: starting new recording (meeting_start), joining a platform, reading a historical file, microphone/multi-source capture, or external sharing. Output: exact current capture admission and status or needs_source/error; never creates a recording. Current complete direct owner request and capture thread ownership are checked independently.',
    governance: governance('handleLiveMeetingAttach', 'attach', true),
  }),
  define({
    name: 'cat_cafe_meeting_status',
    inputSchema: {},
    handler: handleLiveMeetingStatus,
    description:
      'Read the meeting capture admitted to the current owner Live call. Use when: checking whether this call is listening, privately sharing, paused, receiving PCM, or processing chunks. NOT for: reading another call/capture, reading transcript text, or starting/recovering capture. Output: exact meeting/source, sharing state, PCM byte/peak observations and ASR state, or idle/unconfirmed. GOTCHA: the original E failure had running and ASR ready with zero chunks; silent/nonzero PCM never proves successful speech transcription.',
    governance: governance('handleLiveMeetingStatus', 'read'),
  }),
  define({
    name: 'cat_cafe_meeting_stop',
    handler: handleLiveMeetingStop,
    inputSchema: {
      requestMessageId,
      meetingId: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Optional exact meeting ID from status. Omit only to stop this call’s admitted or in-flight capture; wrong targets are rejected.',
        ),
    },
    description:
      'Revoke private meeting input immediately and stop this call’s exact F195 capture. Use when: current owner says 停止录音 / 停止听会 / stop recording. NOT for: stopping a different meeting/call, deleting recordings, or stopping all system audio. Output: stopped only after controller/readback confirmation, or an explicit error/unconfirmed with sharing revoked; late transcript cannot enter the revoked call. Stops in-flight starts without admitting their late result. A failed stop retains its exact target for a fresh explicit retry.',
    governance: governance('handleLiveMeetingStop', 'stop', true),
  }),
] as const;
