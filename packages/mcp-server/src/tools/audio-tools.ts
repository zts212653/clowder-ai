import { defineMcpCanonicalFactory, defineMcpMigrationFactory } from '../tool-governance-migration.js';

/**
 * F195 Phase B — Audio capture & transcription MCP tools.
 *
 * All tools call the API-owned audio controller. MCP invocations never own
 * sidecar lease tokens and therefore cannot end capture during shutdown.
 */

import { createMeetingContextBlock } from '@cat-cafe/shared';
import { z } from 'zod';
import type { ToolResult } from './file-tools.js';
import { errorResult, successResult } from './file-tools.js';

const defineTool = defineMcpMigrationFactory('audio-tools.ts', undefined, {
  resourceFamily: 'audio',
  authority: 'local-runtime',
});
const defineCanonicalTool = defineMcpCanonicalFactory('audio-tools.ts', undefined, {
  resourceFamily: 'audio',
  authority: 'local-runtime',
});

const API_URL = process.env.CAT_CAFE_API_URL ?? 'http://127.0.0.1:3004';
const USER_ID = process.env.CAT_CAFE_USER_ID ?? 'default-user';
const AUDIO_INPUT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

async function audioFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${API_URL}/api/audio${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'x-cat-cafe-user': USER_ID,
      ...(process.env.CAT_CAFE_CAT_ID ? { 'x-cat-id': process.env.CAT_CAFE_CAT_ID } : {}),
      ...(init?.headers as Record<string, string>),
    },
  });
}

export async function shutdownActiveAudioCapture(): Promise<void> {
  // Compatibility hook for existing MCP entry points. The API process owns
  // renewal/finalization, so an invocation ending is intentionally neutral.
}

function audioError(err: unknown): string {
  return `Cannot reach Clowder AI API at ${API_URL}: ${err instanceof Error ? err.message : String(err)}`;
}

// ── Schemas ──────────────────────────────────────────────────

export const audioListSourcesInputSchema = {};

export const audioCaptureStartInputSchema = {
  source: z
    .enum(['app', 'mic'])
    .describe('Audio source: "app" for app audio via ScreenCaptureKit, "mic" for microphone'),
  app_name: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Stable app ID returned by audio_list_sources — REQUIRED when source="app"'),
  device: z.number().int().optional().describe('Mic device index for source=mic (omit for default)'),
  label: z.string().trim().min(1).optional().describe('Human-readable label for the primary input'),
  speaker_evidence: z
    .object({
      kind: z.enum(['provider_track', 'exclusive_source']),
      speaker_id: z.string().trim().min(1),
      speaker_label: z.string().trim().min(1),
    })
    .optional()
    .describe('Provider track identity or an explicitly exclusive speaker source; app identity alone is not evidence'),
  chunk_sec: z.number().min(0.5).optional().describe('ASR chunk duration in seconds (default 3.0, min 0.5)'),
  meeting_id: z.string().optional().describe('Meeting session ID — binds this capture to a MeetingSession'),
  thread_id: z.string().trim().min(1).describe('Thread ID — required controller lease owner for active capture'),
  additional_inputs: z
    .array(
      z.object({
        id: z
          .string()
          .trim()
          .regex(
            AUDIO_INPUT_ID_PATTERN,
            'Input ID must start with an alphanumeric and contain only alphanumerics, dot, underscore, or hyphen',
          ),
        source: z.enum(['app', 'mic']),
        app_name: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe('Stable app ID returned by audio_list_sources — REQUIRED when this input source="app"'),
        device: z.number().int().optional(),
        label: z.string().trim().min(1).optional(),
        speaker_evidence: z
          .object({
            kind: z.enum(['provider_track', 'exclusive_source']),
            speaker_id: z.string().trim().min(1),
            speaker_label: z.string().trim().min(1),
          })
          .optional(),
      }),
    )
    .max(7)
    .optional()
    .describe('Up to seven additional inputs captured in the same AudioSession (eight total)'),
};

export const audioCaptureStopInputSchema = {};

export const audioCaptureStatusInputSchema = {};

export const audioEnrollSpeakersInputSchema = {
  participants: z
    .array(
      z.object({
        id: z.string().describe('Unique participant ID'),
        name: z.string().describe('Display name'),
        role: z.enum(['host', 'participant']).optional().describe('Role — "host" is the local user (mic source)'),
        voice_sample: z
          .string()
          .optional()
          .describe('Optional base64 16 kHz mono PCM enrollment sample; metadata alone is never identity evidence'),
      }),
    )
    .min(1)
    .describe('List of meeting participants to enroll for speaker attribution'),
};

export const audioReadTranscriptInputSchema = {
  from: z.number().optional().describe('Start timestamp (unix epoch seconds)'),
  to: z.number().optional().describe('End timestamp (unix epoch seconds)'),
  latest: z.number().int().optional().describe('Return only the latest N lines'),
  mode: z
    .enum(['raw', 'summary', 'full'])
    .optional()
    .describe(
      'Transcript mode: "raw" (default) returns raw lines, "summary" returns compressed event summaries of older transcript, "full" returns summaries + recent raw lines',
    ),
  format: z
    .enum(['text', 'context_block'])
    .optional()
    .describe(
      'Output format: "text" (default) returns formatted text, "context_block" returns MeetingContextBlock JSON array for invocation data injection',
    ),
};

// ── Handlers ─────────────────────────────────────────────────

type SourceInfo = {
  apps: Array<{ id: string; name: string }>;
  mics: Array<{ index: number; name: string; default: boolean }>;
};

export async function handleAudioListSources(): Promise<ToolResult> {
  try {
    const resp = await audioFetch('/sources');
    if (!resp.ok) return errorResult(`Audio service error: ${resp.status}`);
    const data = (await resp.json()) as SourceInfo;
    const apps = data.apps?.length ? data.apps.map((app) => `${app.name} [${app.id}]`).join('\n  ') : '(none detected)';
    const mics = data.mics?.length
      ? data.mics.map((m) => `  [${m.index}] ${m.name}${m.default ? ' (default)' : ''}`).join('\n')
      : '  (none)';
    return successResult(`Available audio sources:\n\nApps:\n  ${apps}\n\nMicrophones:\n${mics}`);
  } catch (err) {
    return errorResult(audioError(err));
  }
}

type StartInput = {
  source: 'app' | 'mic';
  app_name?: string;
  device?: number;
  label?: string;
  speaker_evidence?: {
    kind: 'provider_track' | 'exclusive_source';
    speaker_id: string;
    speaker_label: string;
  };
  chunk_sec?: number;
  meeting_id?: string;
  thread_id: string;
  additional_inputs?: Array<{
    id: string;
    source: 'app' | 'mic';
    app_name?: string;
    device?: number;
    label?: string;
    speaker_evidence?: {
      kind: 'provider_track' | 'exclusive_source';
      speaker_id: string;
      speaker_label: string;
    };
  }>;
};

export async function handleAudioCaptureStart(input: StartInput): Promise<ToolResult> {
  try {
    const threadId = input.thread_id.trim();
    const { additional_inputs: additionalInputs = [], ...legacy } = input;
    const inputs = [
      {
        id: 'primary',
        source: legacy.source,
        ...(legacy.app_name ? { app_name: legacy.app_name } : {}),
        ...(legacy.device !== undefined ? { device: legacy.device } : {}),
        ...(legacy.label ? { label: legacy.label } : {}),
        ...(legacy.speaker_evidence ? { speaker_evidence: legacy.speaker_evidence } : {}),
      },
      ...additionalInputs,
    ];
    const resp = await audioFetch('/start', {
      method: 'POST',
      body: JSON.stringify({
        chunk_sec: legacy.chunk_sec,
        meeting_id: legacy.meeting_id,
        thread_id: threadId,
        inputs,
      }),
    });
    const data = (await resp.json()) as {
      ok?: boolean;
      error?: string;
      action?: { start_endpoint?: string; logs_endpoint?: string };
      status?: {
        source?: string;
        app_name?: string;
        meeting_id?: string;
        thread_id?: string;
        inputs?: Array<{ id: string; source: string; label?: string; state?: string }>;
      };
    };
    if (!resp.ok) {
      const recovery =
        typeof data.action?.start_endpoint === 'string' && typeof data.action.logs_endpoint === 'string'
          ? `\nRecovery: POST ${data.action.start_endpoint}; inspect GET ${data.action.logs_endpoint}`
          : '';
      return errorResult(`${data.error ?? `Start failed: ${resp.status}`}${recovery}`);
    }
    const s = data.status;
    const label = s?.inputs?.length
      ? s.inputs.map((item) => `${item.label ?? item.id} [${item.state ?? item.source}]`).join(', ')
      : s?.app_name
        ? `${s.source} (${s.app_name})`
        : s?.source;
    const meeting = s?.meeting_id ? ` [meeting=${s.meeting_id}]` : '';
    return successResult(
      `Audio capture started: ${label}${meeting}. Transcription will appear as chunks are processed.`,
    );
  } catch (err) {
    return errorResult(audioError(err));
  }
}

export async function handleAudioCaptureStop(): Promise<ToolResult> {
  try {
    const resp = await audioFetch('/stop', {
      method: 'POST',
    });
    const data = (await resp.json()) as {
      summary?: {
        chunks?: number;
        duration_s?: number;
        avg_asr_latency?: number;
        transcript_path?: string;
        recording_path?: string;
        recording_paths?: Record<string, string>;
        error?: string;
      };
    };
    if (!resp.ok) return errorResult(`Stop failed: ${resp.status}`);
    const s = data.summary;
    if (!s || s.error) return successResult(s?.error ?? 'No active session.');
    const txLine = s.transcript_path ? `\n  Transcript: ${s.transcript_path}` : '';
    const recLine = s.recording_path ? `\n  Recording: ${s.recording_path}` : '';
    const recLines =
      !s.recording_path && s.recording_paths
        ? Object.entries(s.recording_paths)
            .map(([inputId, path]) => `\n  Recording (${inputId}): ${path}`)
            .join('')
        : '';
    return successResult(
      `Capture stopped.\n  Chunks: ${s.chunks}\n  Duration: ${s.duration_s}s\n  Avg ASR latency: ${s.avg_asr_latency}s${txLine}${recLine}${recLines}`,
    );
  } catch (err) {
    return errorResult(audioError(err));
  }
}

type StatusResp = {
  running: boolean;
  source?: string;
  app_name?: string;
  duration_s?: number;
  chunk_count?: number;
  avg_asr_latency?: number;
  meeting_id?: string;
  thread_id?: string;
  participants?: { id: string; name: string; role?: string }[];
  advisory_mode?: string;
  talking_points?: string[];
  health?: Record<string, { state?: string; reason?: string; model?: string }>;
  cluster_diagnostics?: {
    confirmed: number;
    provisional: number;
    max_clusters: number;
    confirmations_required: number;
    birth_threshold: number;
    assignment_threshold: number;
    replacements: number;
  };
  inputs?: Array<{
    id: string;
    source: string;
    label?: string;
    state?: string;
    reason?: string | null;
    chunk_count?: number;
    deduplicated_chunks?: number;
  }>;
};

function formatClusterDiagnostics(diagnostics: StatusResp['cluster_diagnostics']): string {
  if (!diagnostics) return '';
  return `\n  Speaker clusters: ${diagnostics.confirmed} confirmed; ${diagnostics.provisional} learning; ${diagnostics.replacements} recovered; birth>=${diagnostics.birth_threshold}; assignment>=${diagnostics.assignment_threshold}`;
}

export async function handleAudioCaptureStatus(): Promise<ToolResult> {
  try {
    const resp = await audioFetch('/status');
    if (!resp.ok) return errorResult(`Audio service error: ${resp.status}`);
    const s = (await resp.json()) as StatusResp;
    if (!s.running) return successResult('Not currently capturing audio.');
    const label = s.inputs?.length
      ? s.inputs.map((item) => `${item.label ?? item.id} [${item.source}/${item.state ?? 'unknown'}]`).join(', ')
      : s.app_name
        ? `${s.source} (${s.app_name})`
        : (s.source ?? 'unknown');
    const meeting = s.meeting_id ? `\n  Meeting: ${s.meeting_id}` : '';
    const thread = s.thread_id ? `\n  Thread: ${s.thread_id}` : '';
    const speakers = s.participants?.length
      ? `\n  Participants: ${s.participants.map((p) => `${p.name}${p.role === 'host' ? ' (host)' : ''}`).join(', ')}`
      : '';
    const advisory = s.advisory_mode && s.advisory_mode !== 'passive' ? `\n  Advisory: ${s.advisory_mode}` : '';
    const points = s.talking_points?.length ? `\n  Talking points: ${s.talking_points.length} registered` : '';
    const inputs = s.inputs?.length
      ? `\n  Inputs:\n${s.inputs
          .map(
            (item) =>
              `    ${item.label ?? item.id}: ${item.state ?? 'unknown'}; chunks=${item.chunk_count ?? 0}; dedup=${item.deduplicated_chunks ?? 0}${item.reason ? `; reason=${item.reason}` : ''}`,
          )
          .join('\n')}`
      : '';
    const health = s.health
      ? `\n  Health: ${Object.entries(s.health)
          .map(
            ([name, component]) =>
              `${name}=${component.state ?? 'unknown'}${component.reason ? ` (${component.reason})` : ''}`,
          )
          .join(', ')}`
      : '';
    const clusters = formatClusterDiagnostics(s.cluster_diagnostics);
    return successResult(
      `Capturing: ${label}\n  Duration: ${s.duration_s}s | Chunks: ${s.chunk_count} | Avg ASR: ${s.avg_asr_latency}s${meeting}${thread}${speakers}${advisory}${points}${health}${clusters}${inputs}`,
    );
  } catch (err) {
    return errorResult(audioError(err));
  }
}

type TranscriptLine = {
  ts: number;
  elapsed_s: number;
  chunk_num: number;
  asr_latency: number;
  text: string;
  speaker_label?: string;
  speaker_confidence?: number;
  speaker_id?: string | null;
  speaker_identity_source?: string;
  input_id?: string;
  input_source?: string;
  input_label?: string;
};
type TranscriptSummary = { time_range: [number, number]; line_count: number; duration_s: number; key_lines: string[] };

function formatLines(lines: TranscriptLine[]): string {
  if (lines.length === 0) return 'No transcript lines available.';
  const text = lines
    .map((l) => {
      const t = new Date(l.ts * 1000).toLocaleTimeString('zh-CN', { hour12: false });
      const speaker = l.speaker_label ? `${l.speaker_label}: ` : '';
      const source = l.input_label ?? l.input_id ?? l.input_source;
      return `[${t}]${source ? ` [${source}]` : ''} ${speaker}${l.text}`;
    })
    .join('\n');
  return `${lines.length} transcript lines:\n\n${text}`;
}

function formatSummaries(summaries: TranscriptSummary[]): string {
  if (summaries.length === 0) return 'No summaries yet (all transcript within rolling window).';
  return summaries
    .map((s, i) => {
      const from = new Date(s.time_range[0] * 1000).toLocaleTimeString('zh-CN', { hour12: false });
      const to = new Date(s.time_range[1] * 1000).toLocaleTimeString('zh-CN', { hour12: false });
      const lines = s.key_lines.map((l) => `    ${l}`).join('\n');
      return `[Summary ${i + 1}] ${from}–${to} (${s.line_count} lines, ${s.duration_s}s)\n${lines}`;
    })
    .join('\n\n');
}

export async function handleAudioReadTranscript(input: {
  from?: number;
  to?: number;
  latest?: number;
  mode?: 'raw' | 'summary' | 'full';
  format?: 'text' | 'context_block';
}): Promise<ToolResult> {
  try {
    const params = new URLSearchParams();
    if (input.from != null) params.set('from', String(input.from));
    if (input.to != null) params.set('to', String(input.to));
    if (input.latest != null) params.set('latest', String(input.latest));
    if (input.mode) params.set('mode', input.mode);
    const qs = params.toString();

    const [transcriptResp, statusResp] = await Promise.all([
      audioFetch(`/transcript${qs ? `?${qs}` : ''}`),
      input.format === 'context_block' ? audioFetch('/status') : Promise.resolve(null),
    ]);
    if (!transcriptResp.ok) return errorResult(`Audio service error: ${transcriptResp.status}`);

    const mode = input.mode ?? 'raw';

    if (input.format === 'context_block' && mode !== 'raw') {
      return errorResult('format="context_block" only works with mode="raw"');
    }

    if (input.format === 'context_block' && mode === 'raw') {
      const data = (await transcriptResp.json()) as { lines: TranscriptLine[] };
      const lines = data.lines ?? [];
      if (lines.length === 0) return successResult('[]');
      const status = statusResp?.ok ? ((await statusResp.json()) as StatusResp) : null;
      const meetingId = status?.meeting_id ?? 'unknown';
      const blocks = lines
        .filter((l) => l.text && !l.text.startsWith('[ASR error'))
        .flatMap((l) => {
          try {
            return [
              createMeetingContextBlock({
                meetingId,
                speakerId: l.speaker_id ?? undefined,
                speakerLabel: l.speaker_label ?? '参会者',
                speakerConfidence: l.speaker_confidence ?? 0.5,
                speakerIdentitySource: l.speaker_identity_source,
                inputId: l.input_id,
                inputSource: l.input_source,
                inputLabel: l.input_label,
                timestamp: l.ts,
                content: l.text,
              }),
            ];
          } catch {
            return [];
          }
        });
      return successResult(JSON.stringify(blocks, null, 2));
    }

    if (mode === 'summary') {
      const data = (await transcriptResp.json()) as { summaries: TranscriptSummary[] };
      return successResult(formatSummaries(data.summaries ?? []));
    }
    if (mode === 'full') {
      const data = (await transcriptResp.json()) as { summaries: TranscriptSummary[]; raw_lines: TranscriptLine[] };
      const sumText = formatSummaries(data.summaries ?? []);
      const rawText = formatLines(data.raw_lines ?? []);
      return successResult(`── Summaries ──\n${sumText}\n\n── Recent ──\n${rawText}`);
    }
    const data = (await transcriptResp.json()) as { lines: TranscriptLine[] };
    return successResult(formatLines(data.lines ?? []));
  } catch (err) {
    return errorResult(audioError(err));
  }
}

type EnrollInput = {
  participants: Array<{
    id: string;
    name: string;
    role?: 'host' | 'participant';
    voice_sample?: string;
  }>;
};

export async function handleAudioEnrollSpeakers(input: EnrollInput): Promise<ToolResult> {
  try {
    const resp = await audioFetch('/enroll', { method: 'POST', body: JSON.stringify(input) });
    const data = (await resp.json()) as { ok?: boolean; error?: string; participants?: unknown[] };
    if (!resp.ok) return errorResult(data.error ?? `Enrollment failed: ${resp.status}`);
    return successResult(`Enrolled ${data.participants?.length ?? 0} participants for speaker attribution.`);
  } catch (err) {
    return errorResult(audioError(err));
  }
}

export const audioSetAdvisoryModeInputSchema = {
  mode: z
    .enum(['active', 'passive'])
    .describe('Advisory mode: "active" enables intervention hints, "passive" (default) disables them'),
};

export const audioSetTalkingPointsInputSchema = {
  points: z.array(z.string()).describe('List of talking points to match against transcript during active advisory'),
};

export async function handleAudioSetAdvisoryMode(input: { mode: 'active' | 'passive' }): Promise<ToolResult> {
  try {
    const resp = await audioFetch('/advisory-mode', { method: 'POST', body: JSON.stringify(input) });
    const data = (await resp.json()) as { ok?: boolean; error?: string; advisory_mode?: string };
    if (!resp.ok) return errorResult(data.error ?? `Set advisory mode failed: ${resp.status}`);
    return successResult(`Advisory mode set to "${data.advisory_mode}".`);
  } catch (err) {
    return errorResult(audioError(err));
  }
}

export async function handleAudioSetTalkingPoints(input: { points: string[] }): Promise<ToolResult> {
  try {
    const resp = await audioFetch('/talking-points', { method: 'POST', body: JSON.stringify(input) });
    const data = (await resp.json()) as { ok?: boolean; error?: string; talking_points?: string[] };
    if (!resp.ok) return errorResult(data.error ?? `Set talking points failed: ${resp.status}`);
    return successResult(`Registered ${data.talking_points?.length ?? 0} talking points for advisory matching.`);
  } catch (err) {
    return errorResult(audioError(err));
  }
}

// ── Tool Definitions ─────────────────────────────────────────

export const audioTools = [
  defineTool({
    name: 'cat_cafe_audio_list_sources',
    description:
      'List ScreenCaptureKit App sources and microphone devices accepted by live-audio capture. Use when: the user asks to monitor/listen to an App, meeting, video, or microphone, and before every App capture start. NOT for: guessing an App coordinate from its process or display name. Output: a read-only source list with each App display name plus its stable capture ID and each microphone index. GOTCHA: pass the returned App ID unchanged as app_name; labels such as WeLinkMeeting may be a different namespace and can fail capture.',
    inputSchema: audioListSourcesInputSchema,
    handler: handleAudioListSources,
    governance: {
      implementationExport: 'handleAudioListSources',
      action: 'command',
      risk: { level: 'read', openWorld: false },
      runtimeProfiles: ['full'],
      targetExposure: 'lazy-discoverable',
    },
  }),
  defineCanonicalTool({
    name: 'cat_cafe_audio_capture_start',
    description:
      'Start one durable live-audio session with a primary source and optional additional app/mic inputs. Use when: the user asks to monitor/listen to a meeting, video, application, microphone, or App + mic together. NOT for: offline audio-file transcription or assigning names from an App/source label. Output: an API-owned capture that persists across MCP invocations and emits transcript lines with separate input-source and speaker-identity coordinates. GOTCHA: for App inputs, first call audio_list_sources and pass its stable App ID unchanged as app_name; MCP shutdown is capture-neutral, and only explicit stop/API lifecycle owns finalization.',
    inputSchema: audioCaptureStartInputSchema,
    handler: handleAudioCaptureStart,
    governance: {
      implementationExport: 'handleAudioCaptureStart',
      action: 'command',
      risk: { level: 'write', openWorld: false },
      runtimeProfiles: ['full'],
      targetExposure: 'lazy-discoverable',
    },
  }),
  defineTool({
    name: 'cat_cafe_audio_capture_stop',
    description:
      'Stop the current audio capture session. Returns a summary with chunk count, duration, and average ASR latency.',
    inputSchema: audioCaptureStopInputSchema,
    handler: handleAudioCaptureStop,
    governance: {
      implementationExport: 'handleAudioCaptureStop',
      action: 'command',
      risk: { level: 'write', openWorld: false },
      runtimeProfiles: ['full'],
      targetExposure: 'lazy-discoverable',
    },
  }),
  defineTool({
    name: 'cat_cafe_audio_capture_status',
    description:
      'Read the current durable live-audio controller and component state. Use when: checking whether monitoring survived another turn, diagnosing missing speakers/transcript, or reporting capture health. NOT for: reading transcript content (use cat_cafe_audio_read_transcript) or proving health from process liveness. Output: ASR/speaker state, every input and degradation reason, duration, chunk and echo-dedup counts.',
    inputSchema: audioCaptureStatusInputSchema,
    handler: handleAudioCaptureStatus,
    governance: {
      implementationExport: 'handleAudioCaptureStatus',
      action: 'command',
      risk: { level: 'read', openWorld: false },
      runtimeProfiles: ['full'],
      targetExposure: 'lazy-discoverable',
    },
  }),
  defineTool({
    name: 'cat_cafe_audio_read_transcript',
    description:
      'Read transcript from the current or most recent audio capture session. mode="raw" (default): use "latest" for N most recent lines, or "from"/"to" timestamps. mode="summary": compressed event summaries of older transcript (beyond 5-min rolling window). mode="full": summaries + recent raw lines together.',
    inputSchema: audioReadTranscriptInputSchema,
    handler: handleAudioReadTranscript,
    governance: {
      implementationExport: 'handleAudioReadTranscript',
      action: 'command',
      risk: { level: 'read', openWorld: false },
      runtimeProfiles: ['full'],
      targetExposure: 'lazy-discoverable',
    },
  }),
  defineCanonicalTool({
    name: 'cat_cafe_audio_enroll_speakers',
    description:
      'Register meeting participant metadata for ASR context and optional base64 voice enrollment. Use when: the user supplies participant names/roles or real 16 kHz PCM voice samples before capture. NOT for: inferring a human identity from participant metadata, App name, or microphone source alone. Output: participant context plus enrolled-voice evidence when a sample is usable. GOTCHA: attribution still follows manual confirmation, provider/exclusive evidence, enrolled voice, session Speaker N, then Unknown.',
    inputSchema: audioEnrollSpeakersInputSchema,
    handler: handleAudioEnrollSpeakers,
    governance: {
      implementationExport: 'handleAudioEnrollSpeakers',
      action: 'command',
      risk: { level: 'write', openWorld: false },
      runtimeProfiles: ['full'],
      targetExposure: 'lazy-discoverable',
    },
  }),
  defineTool({
    name: 'cat_cafe_audio_set_advisory_mode',
    description:
      'Set the advisory mode for the meeting copilot. "active" enables intervention hints (questions, silence, keyword matches) in the floating transcript window. "passive" (default) disables them. Advisory mode is opt-in to prevent attention overload.',
    inputSchema: audioSetAdvisoryModeInputSchema,
    handler: handleAudioSetAdvisoryMode,
    governance: {
      implementationExport: 'handleAudioSetAdvisoryMode',
      action: 'command',
      risk: { level: 'write', openWorld: false },
      runtimeProfiles: ['full'],
      targetExposure: 'lazy-discoverable',
    },
  }),
  defineTool({
    name: 'cat_cafe_audio_set_talking_points',
    description:
      'Register talking points for advisory keyword matching. When advisory mode is active and transcript mentions keywords from these points, a hint appears in the floating transcript window. Points must be user-provided — never generated from transcript.',
    inputSchema: audioSetTalkingPointsInputSchema,
    handler: handleAudioSetTalkingPoints,
    governance: {
      implementationExport: 'handleAudioSetTalkingPoints',
      action: 'command',
      risk: { level: 'write', openWorld: false },
      runtimeProfiles: ['full'],
      targetExposure: 'lazy-discoverable',
    },
  }),
] as const;
