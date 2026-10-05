import { createHash } from 'node:crypto';
import { projectInvocationTerminalEvidence } from '../InvocationTrajectoryProjector.js';
import { transcriptEventFingerprint } from '../TranscriptEventEnvelope.js';
import type { TranscriptEvent } from '../TranscriptReader.js';
import { materializeFilesTouched, recordFilesTouched } from '../transcript-file-touches.js';
import type { CompactTranscriptEvent } from './transcript-invocation-index-types.js';

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

/** Only fields consumed by the trajectory projector; the canonical payload remains in JSONL/buffer. */
export function compactTranscriptEvent(envelope: TranscriptEvent): CompactTranscriptEvent {
  const event = envelope.event;
  const projected: Record<string, unknown> = { type: event.type };
  const terminal = projectInvocationTerminalEvidence(event);
  if (terminal) projected.errorCode = terminal.reason;
  if (event.type === 'error' && event.errorDisposition === 'transient') projected.errorDisposition = 'transient';
  if (event.type === 'tool_result') projected.toolResultStatus = event.toolResultStatus;
  if (event.type === 'tool_use') projected.toolName = event.toolName ?? event.name;
  if (['text', 'assistant', 'user', 'system'].includes(String(event.type))) {
    const content =
      typeof event.content === 'string'
        ? event.content
        : Array.isArray(event.content)
          ? event.content
              .flatMap((part) => {
                const text = record(part);
                return text?.type === 'text' && typeof text.text === 'string' ? [text.text] : [];
              })
              .join('\n')
          : undefined;
    if (content) projected.content = content.slice(0, 140);
  }
  const usage = record(record(event.metadata)?.usage);
  if (usage)
    projected.metadata = {
      usage: Object.fromEntries(
        ['inputTokens', 'outputTokens', 'cacheReadTokens', 'totalTokens']
          .filter((key) => typeof usage[key] === 'number')
          .map((key) => [key, usage[key]]),
      ),
    };
  const files = new Map<string, Set<string>>();
  recordFilesTouched(files, event, (event.toolName ?? event.name) as string | undefined);
  return {
    hash: createHash('sha256').update(transcriptEventFingerprint(envelope)).digest('hex'),
    projection: { ...envelope, event: projected },
    filesTouched: materializeFilesTouched(files),
  };
}
