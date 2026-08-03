/**
 * F195 Phase B — Audio capture & transcription MCP tools.
 *
 * All tools proxy to the standalone audio-service (Python, default :9881).
 */

import { randomUUID } from 'node:crypto';
import { createMeetingContextBlock } from '@cat-cafe/shared';
import { z } from 'zod';
import type { ToolResult } from './file-tools.js';
import { errorResult, successResult } from './file-tools.js';

const AUDIO_URL = process.env.AUDIO_SERVICE_URL ?? 'http://127.0.0.1:9881';
const CONTROLLER_LEASE_TTL_S = 15;
const SHUTDOWN_STOP_TIMEOUT_MS = 5_000;

type ActiveCaptureLease = {
  token: string;
  threadId: string;
  heartbeat: NodeJS.Timeout;
  expiresAtMs: number;
};

let activeCaptureLease: ActiveCaptureLease | null = null;

async function audioFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${AUDIO_URL}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers as Record<string, string>) },
  });
}

function releaseActiveCaptureLease(lease: ActiveCaptureLease): void {
  clearInterval(lease.heartbeat);
  if (activeCaptureLease === lease) activeCaptureLease = null;
}

function releaseActiveCaptureLeaseIfExpired(lease: ActiveCaptureLease | null): boolean {
  if (!lease || Date.now() < lease.expiresAtMs) return false;
  releaseActiveCaptureLease(lease);
  return true;
}

function getActiveCaptureLease(): ActiveCaptureLease | null {
  const lease = activeCaptureLease;
  return releaseActiveCaptureLeaseIfExpired(lease) ? null : lease;
}

async function renewActiveCaptureLease(): Promise<void> {
  const lease = activeCaptureLease;
  if (!lease) return;
  try {
    const resp = await audioFetch('/lease', {
      method: 'POST',
      body: JSON.stringify({ lease_token: lease.token, thread_id: lease.threadId }),
      signal: AbortSignal.timeout(2_000),
    });
    if (!resp.ok) {
      console.error(`[audio] controller lease rejected (${resp.status}); capture will expire`);
      releaseActiveCaptureLease(lease);
    } else if (activeCaptureLease === lease) {
      lease.expiresAtMs = Date.now() + CONTROLLER_LEASE_TTL_S * 1000;
    }
  } catch (err) {
    if (releaseActiveCaptureLeaseIfExpired(lease)) {
      console.error(`[audio] controller lease expired after renewal failures: ${audioError(err)}`);
    } else {
      // Keep retrying transient failures until the last confirmed renewal
      // expires. The sidecar independently finalizes on the same TTL.
      console.error(`[audio] controller lease renewal failed: ${audioError(err)}`);
    }
  }
}

export async function shutdownActiveAudioCapture(): Promise<void> {
  const lease = activeCaptureLease;
  activeCaptureLease = null;
  if (!lease) return;
  clearInterval(lease.heartbeat);
  try {
    const resp = await audioFetch('/stop', {
      method: 'POST',
      body: JSON.stringify({
        lease_token: lease.token,
        reason: 'runtime-graceful-shutdown',
      }),
      signal: AbortSignal.timeout(SHUTDOWN_STOP_TIMEOUT_MS),
    });
    if (!resp.ok) {
      console.error(`[audio] graceful capture stop rejected (${resp.status}); waiting for lease expiry`);
    }
  } catch (err) {
    // The sidecar still converges through lease expiry if shutdown races it.
    console.error(`[audio] graceful capture stop failed: ${audioError(err)}`);
  }
}

function audioError(err: unknown): string {
  return `Cannot reach audio service at ${AUDIO_URL}: ${err instanceof Error ? err.message : String(err)}`;
}

// ── Schemas ──────────────────────────────────────────────────

export const audioListSourcesInputSchema = {};

export const audioCaptureStartInputSchema = {
  source: z
    .enum(['app', 'mic'])
    .describe('Audio source: "app" for app audio via ScreenCaptureKit, "mic" for microphone'),
  app_name: z
    .string()
    .optional()
    .describe('Target app name — REQUIRED when source="app" (e.g. "Google Chrome", "zoom.us", "腾讯会议")'),
  device: z.number().int().optional().describe('Mic device index for source=mic (omit for default)'),
  chunk_sec: z.number().min(0.5).optional().describe('ASR chunk duration in seconds (default 3.0, min 0.5)'),
  meeting_id: z.string().optional().describe('Meeting session ID — binds this capture to a MeetingSession'),
  thread_id: z.string().trim().min(1).describe('Thread ID — required controller lease owner for active capture'),
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

type SourceInfo = { apps: string[]; mics: Array<{ index: number; name: string; default: boolean }> };

export async function handleAudioListSources(): Promise<ToolResult> {
  try {
    const resp = await audioFetch('/sources');
    if (!resp.ok) return errorResult(`Audio service error: ${resp.status}`);
    const data = (await resp.json()) as SourceInfo;
    const apps = data.apps?.length ? data.apps.join(', ') : '(none detected)';
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
  chunk_sec?: number;
  meeting_id?: string;
  thread_id: string;
};

export async function handleAudioCaptureStart(input: StartInput): Promise<ToolResult> {
  if (getActiveCaptureLease()) {
    return errorResult('Audio capture is already owned by this MCP runtime. Stop it before starting another.');
  }
  try {
    const threadId = input.thread_id.trim();
    const resp = await audioFetch('/start', {
      method: 'POST',
      body: JSON.stringify({
        ...input,
        thread_id: threadId,
        controller_id: `mcp-runtime:${process.pid}:${randomUUID()}`,
        lease_ttl_s: CONTROLLER_LEASE_TTL_S,
      }),
    });
    const data = (await resp.json()) as {
      ok?: boolean;
      error?: string;
      lease_token?: string;
      action?: { start_endpoint?: string; logs_endpoint?: string };
      status?: { source: string; app_name?: string; meeting_id?: string; thread_id?: string };
    };
    if (!resp.ok) {
      const recovery =
        typeof data.action?.start_endpoint === 'string' && typeof data.action.logs_endpoint === 'string'
          ? `\nRecovery: POST ${data.action.start_endpoint}; inspect GET ${data.action.logs_endpoint}`
          : '';
      return errorResult(`${data.error ?? `Start failed: ${resp.status}`}${recovery}`);
    }
    if (!data.lease_token) return errorResult('Audio service start omitted controller lease token.');
    const heartbeat = setInterval(() => void renewActiveCaptureLease(), (CONTROLLER_LEASE_TTL_S * 1000) / 3);
    heartbeat.unref();
    activeCaptureLease = {
      token: data.lease_token,
      threadId,
      heartbeat,
      expiresAtMs: Date.now() + CONTROLLER_LEASE_TTL_S * 1000,
    };
    const s = data.status;
    const label = s?.app_name ? `${s.source} (${s.app_name})` : s?.source;
    const meeting = s?.meeting_id ? ` [meeting=${s.meeting_id}]` : '';
    return successResult(
      `Audio capture started: ${label}${meeting}. Transcription will appear as chunks are processed.`,
    );
  } catch (err) {
    return errorResult(audioError(err));
  }
}

export async function handleAudioCaptureStop(): Promise<ToolResult> {
  const lease = getActiveCaptureLease();
  if (!lease) return errorResult('No audio capture lease is owned by this MCP runtime.');
  try {
    const resp = await audioFetch('/stop', {
      method: 'POST',
      body: JSON.stringify({ lease_token: lease.token, reason: 'controller-stop' }),
    });
    const data = (await resp.json()) as {
      summary?: {
        chunks?: number;
        duration_s?: number;
        avg_asr_latency?: number;
        transcript_path?: string;
        recording_path?: string;
        error?: string;
      };
    };
    if (!resp.ok) return errorResult(`Stop failed: ${resp.status}`);
    releaseActiveCaptureLease(lease);
    const s = data.summary;
    if (!s || s.error) return successResult(s?.error ?? 'No active session.');
    const txLine = s.transcript_path ? `\n  Transcript: ${s.transcript_path}` : '';
    const recLine = s.recording_path ? `\n  Recording: ${s.recording_path}` : '';
    return successResult(
      `Capture stopped.\n  Chunks: ${s.chunks}\n  Duration: ${s.duration_s}s\n  Avg ASR latency: ${s.avg_asr_latency}s${txLine}${recLine}`,
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
};

export async function handleAudioCaptureStatus(): Promise<ToolResult> {
  try {
    const resp = await audioFetch('/status');
    if (!resp.ok) return errorResult(`Audio service error: ${resp.status}`);
    const s = (await resp.json()) as StatusResp;
    if (!s.running) return successResult('Not currently capturing audio.');
    const label = s.app_name ? `${s.source} (${s.app_name})` : (s.source ?? 'unknown');
    const meeting = s.meeting_id ? `\n  Meeting: ${s.meeting_id}` : '';
    const thread = s.thread_id ? `\n  Thread: ${s.thread_id}` : '';
    const speakers = s.participants?.length
      ? `\n  Participants: ${s.participants.map((p) => `${p.name}${p.role === 'host' ? ' (host)' : ''}`).join(', ')}`
      : '';
    const advisory = s.advisory_mode && s.advisory_mode !== 'passive' ? `\n  Advisory: ${s.advisory_mode}` : '';
    const points = s.talking_points?.length ? `\n  Talking points: ${s.talking_points.length} registered` : '';
    return successResult(
      `Capturing: ${label}\n  Duration: ${s.duration_s}s | Chunks: ${s.chunk_count} | Avg ASR: ${s.avg_asr_latency}s${meeting}${thread}${speakers}${advisory}${points}`,
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
};
type TranscriptSummary = { time_range: [number, number]; line_count: number; duration_s: number; key_lines: string[] };

function formatLines(lines: TranscriptLine[]): string {
  if (lines.length === 0) return 'No transcript lines available.';
  const text = lines
    .map((l) => {
      const t = new Date(l.ts * 1000).toLocaleTimeString('zh-CN', { hour12: false });
      const speaker = l.speaker_label ? `${l.speaker_label}: ` : '';
      return `[${t}] ${speaker}${l.text}`;
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

type EnrollInput = { participants: Array<{ id: string; name: string; role?: 'host' | 'participant' }> };

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
  {
    name: 'cat_cafe_audio_list_sources',
    description:
      'List available audio capture sources: running applications (for per-app ScreenCaptureKit capture) and microphone devices.',
    inputSchema: audioListSourcesInputSchema,
    handler: handleAudioListSources,
  },
  {
    name: 'cat_cafe_audio_capture_start',
    description:
      'Start real-time audio capture and transcription. source="app" captures a specific application\'s audio via ScreenCaptureKit (requires app_name). source="mic" captures from the system microphone. Audio is automatically chunked and transcribed via ASR.',
    inputSchema: audioCaptureStartInputSchema,
    handler: handleAudioCaptureStart,
  },
  {
    name: 'cat_cafe_audio_capture_stop',
    description:
      'Stop the current audio capture session. Returns a summary with chunk count, duration, and average ASR latency.',
    inputSchema: audioCaptureStopInputSchema,
    handler: handleAudioCaptureStop,
  },
  {
    name: 'cat_cafe_audio_capture_status',
    description: 'Check current audio capture status: whether capturing, source type, duration, and chunk count.',
    inputSchema: audioCaptureStatusInputSchema,
    handler: handleAudioCaptureStatus,
  },
  {
    name: 'cat_cafe_audio_read_transcript',
    description:
      'Read transcript from the current or most recent audio capture session. mode="raw" (default): use "latest" for N most recent lines, or "from"/"to" timestamps. mode="summary": compressed event summaries of older transcript (beyond 5-min rolling window). mode="full": summaries + recent raw lines together.',
    inputSchema: audioReadTranscriptInputSchema,
    handler: handleAudioReadTranscript,
  },
  {
    name: 'cat_cafe_audio_enroll_speakers',
    description:
      'Enroll meeting participants for speaker attribution. Call before starting capture. The host (role="host") maps to mic source; other participants map to app/system audio. With 2 total participants, the non-host gets attributed by name. With 3+, non-host lines show "有人说" (confidence below threshold).',
    inputSchema: audioEnrollSpeakersInputSchema,
    handler: handleAudioEnrollSpeakers,
  },
  {
    name: 'cat_cafe_audio_set_advisory_mode',
    description:
      'Set the advisory mode for the meeting copilot. "active" enables intervention hints (questions, silence, keyword matches) in the floating transcript window. "passive" (default) disables them. Advisory mode is opt-in to prevent attention overload.',
    inputSchema: audioSetAdvisoryModeInputSchema,
    handler: handleAudioSetAdvisoryMode,
  },
  {
    name: 'cat_cafe_audio_set_talking_points',
    description:
      'Register talking points for advisory keyword matching. When advisory mode is active and transcript mentions keywords from these points, a hint appears in the floating transcript window. Points must be user-provided — never generated from transcript.',
    inputSchema: audioSetTalkingPointsInputSchema,
    handler: handleAudioSetTalkingPoints,
  },
] as const;
