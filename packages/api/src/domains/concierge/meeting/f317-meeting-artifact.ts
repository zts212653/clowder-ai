import { readFile, realpath, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { createMeetingContextBlock, type MeetingContextBlock } from '@cat-cafe/shared';

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;
const MAX_LINE_CHARS = 32_000;

export interface F317MeetingBinding {
  readonly threadId: string;
  readonly meetingId: string;
  readonly callId: string;
  readonly generation: number;
  /** Last cursor durably accepted by the call consumer, if this call is resuming. */
  readonly afterCursor?: number;
}

export interface F317MeetingContext {
  readonly sourceRef: string;
  readonly artifactId: string;
  readonly cursor: number;
  readonly chunkNum: number;
  readonly revision: number;
  readonly operation: 'transcript' | 'revision';
  readonly callId: string;
  readonly generation: number;
  readonly epoch: number;
  readonly context: MeetingContextBlock;
}

type RecordValue = Readonly<Record<string, unknown>>;

export interface F195Record {
  readonly cursor: number;
  readonly chunkNum: number;
  readonly revision: number;
  readonly operation: 'transcript' | 'revision';
  readonly line: RecordValue;
}

export function object(value: unknown): RecordValue | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as RecordValue) : null;
}

export function validBinding(binding: F317MeetingBinding): boolean {
  return (
    ID_PATTERN.test(binding.threadId) &&
    ID_PATTERN.test(binding.meetingId) &&
    ID_PATTERN.test(binding.callId) &&
    Number.isSafeInteger(binding.generation) &&
    binding.generation >= 0 &&
    (binding.afterCursor === undefined || (Number.isSafeInteger(binding.afterCursor) && binding.afterCursor >= 0))
  );
}

function bounded(value: unknown, length = 256): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= length ? value : undefined;
}

function parseRecord(value: unknown, binding: F317MeetingBinding): F195Record {
  const record = object(value);
  const line = object(record?.line);
  if (
    record?.v !== 1 ||
    (record.kind !== 'transcript' && record.kind !== 'revision') ||
    !Number.isSafeInteger(record.cursor) ||
    (record.cursor as number) < 1 ||
    !Number.isSafeInteger(record.chunk_num) ||
    (record.chunk_num as number) < 1 ||
    !Number.isSafeInteger(record.revision) ||
    (record.revision as number) < 1 ||
    record.meeting_id !== binding.meetingId ||
    record.thread_id !== binding.threadId ||
    !line ||
    line.chunk_num !== record.chunk_num ||
    !bounded(line.text, 8_000) ||
    typeof line.ts !== 'number' ||
    !Number.isFinite(line.ts) ||
    line.ts <= 0
  )
    throw new Error('meeting_source_artifact_invalid');
  return {
    cursor: record.cursor as number,
    chunkNum: record.chunk_num as number,
    revision: record.revision as number,
    operation: record.kind,
    line,
  };
}

export function validateF195Sequence(records: readonly F195Record[], afterCursor: number): void {
  if (afterCursor > records.length) throw new Error('meeting_source_cursor_ahead');
  const revisions = new Map<number, number>();
  for (const [index, record] of records.entries()) {
    if (record.cursor !== index + 1) throw new Error(`meeting_source_cursor_gap:${index + 1}:${record.cursor}`);
    const preceding = revisions.get(record.chunkNum) ?? 0;
    if (
      record.revision !== preceding + 1 ||
      (preceding === 0 ? record.operation !== 'transcript' : record.operation !== 'revision')
    ) {
      throw new Error('meeting_source_revision_gap');
    }
    revisions.set(record.chunkNum, record.revision);
  }
}

export function projectF195Context(
  record: F195Record,
  binding: F317MeetingBinding,
  artifactId: string,
  epoch: number,
): F317MeetingContext {
  const line = record.line;
  const confidence =
    typeof line.speaker_confidence === 'number' && Number.isFinite(line.speaker_confidence)
      ? line.speaker_confidence
      : 0;
  const context = createMeetingContextBlock({
    meetingId: binding.meetingId,
    provenance: 'transcript',
    speakerLabel: bounded(line.speaker_label) ?? '参会者',
    speakerConfidence: confidence,
    ...(confidence >= 0.6 && bounded(line.speaker_id) ? { speakerId: bounded(line.speaker_id) } : {}),
    ...(bounded(line.speaker_identity_source) ? { speakerIdentitySource: bounded(line.speaker_identity_source) } : {}),
    ...(bounded(line.input_id) ? { inputId: bounded(line.input_id) } : {}),
    ...(bounded(line.input_source) ? { inputSource: bounded(line.input_source) } : {}),
    ...(bounded(line.input_label) ? { inputLabel: bounded(line.input_label) } : {}),
    timestamp: line.ts as number,
    content: line.text as string,
  });
  return {
    sourceRef: `f195-transcript:${binding.threadId}:${binding.meetingId}:${artifactId}:${record.chunkNum}:${record.revision}`,
    artifactId,
    cursor: record.cursor,
    chunkNum: record.chunkNum,
    revision: record.revision,
    operation: record.operation,
    callId: binding.callId,
    generation: binding.generation,
    epoch,
    context,
  };
}

async function resolveArtifactPath(
  root: string,
  binding: F317MeetingBinding,
  path: string,
): Promise<{
  path: string;
  artifactId: string;
}> {
  const actualRoot = await realpath(join(resolve(root), binding.threadId));
  if (relative(await realpath(root), actualRoot) !== binding.threadId) {
    throw new Error('meeting_source_artifact_path_invalid');
  }
  const actualPath = await realpath(path);
  const contained = relative(actualRoot, actualPath);
  if (
    !contained ||
    contained.startsWith(`..${sep}`) ||
    contained === '..' ||
    contained.includes(sep) ||
    !/^transcript-[A-Za-z0-9_-]+(?:-[0-9]+)?\.lines\.jsonl$/.test(contained)
  )
    throw new Error('meeting_source_artifact_path_invalid');
  return { path: actualPath, artifactId: contained };
}

export async function readF195Artifact(
  root: string,
  binding: F317MeetingBinding,
): Promise<
  | { state: 'ready'; records: F195Record[]; artifactId: string }
  | { state: 'binding_mismatch' | 'stopped' | 'unavailable'; records: [] }
> {
  try {
    const directory = join(resolve(root), binding.threadId);
    const meta = object(JSON.parse(await readFile(join(directory, 'meta.json'), 'utf8')));
    if (meta?.thread_id !== binding.threadId || meta.meeting_id !== binding.meetingId) {
      return { state: 'binding_mismatch', records: [] };
    }
    if (meta.active !== true) return { state: 'stopped', records: [] };
    if (typeof meta.structured_transcript_path !== 'string') return { state: 'unavailable', records: [] };
    const artifact = await resolveArtifactPath(root, binding, meta.structured_transcript_path);
    const info = await stat(artifact.path);
    if (!info.isFile() || info.size > MAX_ARTIFACT_BYTES) throw new Error('meeting_source_artifact_size_invalid');
    const raw = await readFile(artifact.path, 'utf8');
    const complete = raw.endsWith('\n') ? raw : raw.slice(0, raw.lastIndexOf('\n') + 1);
    const records = complete
      .split('\n')
      .filter(Boolean)
      .map((item) => {
        if (item.length > MAX_LINE_CHARS) throw new Error('meeting_source_artifact_line_too_large');
        return parseRecord(JSON.parse(item), binding);
      });
    return { state: 'ready', records, artifactId: artifact.artifactId };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('meeting_source_')) throw error;
    if (error instanceof SyntaxError) throw new Error('meeting_source_artifact_invalid', { cause: error });
    return { state: 'unavailable', records: [] };
  }
}
