import { createHash } from 'node:crypto';
import type { MeetingArtifactDescriptor } from '@cat-cafe/shared';
import { pageWithinMeetingArtifactBudgets } from './meeting-artifact-read-budget.js';
import {
  type MeetingArtifactReadInput,
  type MeetingArtifactReadView,
  MeetingArtifactResourceError,
  type MeetingArtifactResourceServiceOptions,
  meetingArtifactCarrierIdempotencyKey,
  validateMeetingArtifactReadInput,
} from './meeting-artifact-resource-contract.js';
import { parsePrivateThreadHandle } from './ThreadDestinationAuthority.js';

export {
  type MeetingArtifactReadInput,
  type MeetingArtifactReadView,
  MeetingArtifactResourceError,
  type MeetingArtifactResourceErrorCode,
  type MeetingArtifactResourceServiceOptions,
  meetingArtifactCarrierIdempotencyKey,
} from './meeting-artifact-resource-contract.js';

const RESOURCE_REF = /^meeting-artifact:\/\/intakes\/([^?]+)\?revision=(sha256:[0-9a-f]{64})$/;
const SOURCE_REVISION = /^sha256:[0-9a-f]{64}$/;
const MAX_CURSOR_LENGTH = 1_024;

export function createMeetingArtifactDescriptor(input: {
  readonly intakeId: string;
  readonly sourceHandle: string;
  readonly contentType: 'text/plain';
  readonly text: string;
}): MeetingArtifactDescriptor {
  const digest = createHash('sha256').update(input.text).digest('hex');
  const sourceRevision = `sha256:${digest}` as const;
  return {
    contentType: input.contentType,
    resourceRef: `meeting-artifact://intakes/${encodeURIComponent(input.intakeId)}?revision=${sourceRevision}`,
    sourceHandle: input.sourceHandle,
    sourceRevision,
    byteLength: Buffer.byteLength(input.text, 'utf8'),
    trust: 'untrusted_external',
    instructionPolicy: 'data_only',
  };
}

interface ParsedLine {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly speaker?: string;
  readonly timeMs?: number;
}

interface ReadCursor {
  readonly v: 1;
  readonly resourceRef: string;
  readonly view: MeetingArtifactReadView;
  readonly filterHash: string;
  readonly offset: number;
}

function parseResourceRef(resourceRef: string): { intakeId: string; sourceRevision: string } | null {
  const match = RESOURCE_REF.exec(resourceRef);
  if (!match?.[1] || !match[2]) return null;
  try {
    return { intakeId: decodeURIComponent(match[1]), sourceRevision: match[2] };
  } catch {
    return null;
  }
}

function normalizedFilters(input: MeetingArtifactReadInput) {
  return {
    ...(input.speakers?.length ? { speakers: [...input.speakers].map((value) => value.trim()).sort() } : {}),
    ...(input.startTimeMs === undefined ? {} : { startTimeMs: input.startTimeMs }),
    ...(input.endTimeMs === undefined ? {} : { endTimeMs: input.endTimeMs }),
  };
}

function filterHash(input: MeetingArtifactReadInput): string {
  return createHash('sha256')
    .update(JSON.stringify(normalizedFilters(input)))
    .digest('hex');
}

function encodeCursor(cursor: ReadCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(value: string | undefined, input: MeetingArtifactReadInput): number {
  if (!value) return 0;
  if (value.length > MAX_CURSOR_LENGTH) throw new MeetingArtifactResourceError('INVALID_CURSOR', 'cursor is too long');
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<ReadCursor>;
    if (
      parsed.v !== 1 ||
      parsed.resourceRef !== input.resourceRef ||
      parsed.view !== input.view ||
      parsed.filterHash !== filterHash(input) ||
      !Number.isSafeInteger(parsed.offset) ||
      Number(parsed.offset) < 0
    ) {
      throw new Error('cursor scope mismatch');
    }
    return Number(parsed.offset);
  } catch {
    throw new MeetingArtifactResourceError('INVALID_CURSOR', 'cursor is malformed or belongs to another read');
  }
}

function parseClock(parts: readonly string[]): number | undefined {
  const values = parts.map(Number);
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) return undefined;
  if (values.length === 3) return ((values[0] ?? 0) * 3_600 + (values[1] ?? 0) * 60 + (values[2] ?? 0)) * 1_000;
  if (values.length === 2) return ((values[0] ?? 0) * 60 + (values[1] ?? 0)) * 1_000;
  return undefined;
}

function parseLine(text: string, start: number, end: number): ParsedLine {
  const structural = /^\s*\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?\s+([^:\n]{1,128}):/.exec(text);
  const speakerOnly = structural ? null : /^\s*([^:\n]{1,128}):/.exec(text);
  return {
    start,
    end,
    text,
    ...(structural?.[1] ? { timeMs: parseClock(structural[1].split(':')) } : {}),
    ...(structural?.[2]
      ? { speaker: structural[2].trim() }
      : speakerOnly?.[1]
        ? { speaker: speakerOnly[1].trim() }
        : {}),
  };
}

function lines(text: string): ParsedLine[] {
  const result: ParsedLine[] = [];
  let start = 0;
  while (start < text.length) {
    const newline = text.indexOf('\n', start);
    const end = newline < 0 ? text.length : newline + 1;
    result.push(parseLine(text.slice(start, end), start, end));
    start = end;
  }
  return result;
}

function matches(line: ParsedLine, input: MeetingArtifactReadInput): boolean {
  const speakers = input.speakers?.map((value) => value.trim().toLocaleLowerCase()).filter(Boolean);
  if (speakers?.length && (!line.speaker || !speakers.includes(line.speaker.toLocaleLowerCase()))) return false;
  if (input.startTimeMs !== undefined && (line.timeMs === undefined || line.timeMs < input.startTimeMs)) return false;
  if (input.endTimeMs !== undefined && (line.timeMs === undefined || line.timeMs > input.endTimeMs)) return false;
  return true;
}

function contentPage(text: string, offset: number, budget: number, input: MeetingArtifactReadInput) {
  const hasFilters = Boolean(
    input.speakers?.length || input.startTimeMs !== undefined || input.endTimeMs !== undefined,
  );
  if (!hasFilters) {
    const content = text.slice(offset, offset + budget);
    const nextOffset = offset + content.length;
    return { content, nextOffset, hasMore: nextOffset < text.length };
  }
  let content = '';
  let nextOffset = Math.min(offset, text.length);
  for (const line of lines(text)) {
    if (line.end <= offset) continue;
    if (!matches(line, input)) {
      nextOffset = line.end;
      continue;
    }
    const from = Math.max(offset, line.start);
    const available = line.end - from;
    const take = Math.min(available, budget - content.length);
    content += text.slice(from, from + take);
    nextOffset = from + take;
    if (content.length >= budget) break;
  }
  const hasMore = lines(text).some((line) => line.end > nextOffset && matches(line, input));
  return { content, nextOffset, hasMore };
}

function outlineEntry(line: ParsedLine, index: number): string | null {
  if (!line.speaker && line.timeMs === undefined && index % 50 !== 0) return null;
  const preview = line.text.trim().slice(0, 160);
  const time = line.timeMs === undefined ? '' : ` t=${line.timeMs}ms`;
  const speaker = line.speaker ? ` speaker=${line.speaker}` : '';
  return `@${line.start}${time}${speaker} ${preview}\n`;
}

function outlinePage(text: string, offset: number, budget: number) {
  let content = '';
  let nextOffset = Math.min(offset, text.length);
  const allLines = lines(text);
  for (let index = 0; index < allLines.length; index += 1) {
    const line = allLines[index];
    if (!line || line.end <= offset) continue;
    nextOffset = line.end;
    const entry = outlineEntry(line, index);
    if (!entry) continue;
    if (content.length + entry.length > budget) {
      if (content.length === 0) {
        content = entry.slice(0, budget);
        nextOffset = line.end;
      } else {
        nextOffset = line.start;
      }
      break;
    }
    content += entry;
  }
  return { content, nextOffset, hasMore: nextOffset < text.length };
}

export class MeetingArtifactResourceService {
  constructor(private readonly options: MeetingArtifactResourceServiceOptions) {}

  async read(input: MeetingArtifactReadInput) {
    validateMeetingArtifactReadInput(input);
    const parsedRef = parseResourceRef(input.resourceRef);
    if (!parsedRef) throw new MeetingArtifactResourceError('RESOURCE_NOT_FOUND', 'meeting artifact ref is invalid');
    const intake = await this.options.intakes.get(parsedRef.intakeId);
    if (!intake || intake.ownerId !== input.ownerId) {
      throw new MeetingArtifactResourceError('RESOURCE_NOT_FOUND', 'meeting artifact was not found');
    }
    const descriptor = intake.artifact;
    if (
      !descriptor ||
      descriptor.resourceRef !== input.resourceRef ||
      descriptor.sourceRevision !== parsedRef.sourceRevision ||
      !SOURCE_REVISION.test(descriptor.sourceRevision)
    ) {
      throw new MeetingArtifactResourceError('RESOURCE_REVISION_MISMATCH', 'meeting artifact revision is not current');
    }
    const destinationThreadId = intake.choices.destinationHandle
      ? parsePrivateThreadHandle(intake.choices.destinationHandle)
      : null;
    if (destinationThreadId !== input.threadId) {
      throw new MeetingArtifactResourceError('RESOURCE_FORBIDDEN', 'meeting artifact belongs to another thread');
    }
    const message = await this.options.messages.getByIdempotencyKey(
      input.ownerId,
      input.threadId,
      meetingArtifactCarrierIdempotencyKey(intake.intakeId, descriptor.sourceRevision),
    );
    const carrier = message?.extra?.meetingArtifact;
    if (
      !message ||
      message.source?.connector !== 'feishu' ||
      !message.mentions.some((catId) => catId === input.catId) ||
      carrier?.resourceRef !== descriptor.resourceRef ||
      carrier.sourceRevision !== descriptor.sourceRevision
    ) {
      throw new MeetingArtifactResourceError('RESOURCE_FORBIDDEN', 'cat is not bound to this meeting task');
    }

    const principalId = `meeting-artifact-reader:${input.ownerId}:${input.threadId}:${input.catId}`;
    const lease = await this.options.sources.issue({ intakeId: intake.intakeId, principalId, purpose: 'transcript' });
    const source = await this.options.sources.resolve(
      { intakeId: intake.intakeId, principalId, purpose: 'transcript', grant: lease.grant },
      new AbortController().signal,
    );
    const liveDescriptor = createMeetingArtifactDescriptor({
      intakeId: intake.intakeId,
      sourceHandle: source.provenance.sourceHandle,
      contentType: source.contentType,
      text: source.text,
    });
    if (
      liveDescriptor.sourceRevision !== descriptor.sourceRevision ||
      liveDescriptor.byteLength !== descriptor.byteLength ||
      liveDescriptor.sourceHandle !== descriptor.sourceHandle
    ) {
      throw new MeetingArtifactResourceError(
        'SOURCE_REVISION_CHANGED',
        'source bytes changed after this task was bound',
      );
    }

    const offset = decodeCursor(input.cursor, input);
    const common = {
      resourceRef: descriptor.resourceRef,
      sourceRevision: descriptor.sourceRevision,
      contentType: descriptor.contentType,
      byteLength: descriptor.byteLength,
      provenance: {
        provider: '飞书会议入站 / 录音豆',
        sourceHandle: descriptor.sourceHandle,
        trust: descriptor.trust,
        instructionPolicy: descriptor.instructionPolicy,
      },
      filters: normalizedFilters(input),
    };
    if (input.view === 'overview') {
      const parsedLines = lines(source.text);
      const speakers = [
        ...new Set(parsedLines.map((line) => line.speaker).filter((value): value is string => !!value)),
      ];
      const times = parsedLines.map((line) => line.timeMs).filter((value): value is number => value !== undefined);
      return {
        ...common,
        view: 'overview' as const,
        overview: {
          characterCount: source.text.length,
          detectedSpeakers: speakers.slice(0, 32),
          ...(times.length ? { timeRangeMs: { start: Math.min(...times), end: Math.max(...times) } } : {}),
          availableViews: ['outline', 'content'] as const,
        },
        nextCursor: null,
      };
    }
    const page = pageWithinMeetingArtifactBudgets(
      (characterBudget) =>
        input.view === 'outline'
          ? outlinePage(source.text, offset, characterBudget)
          : contentPage(source.text, offset, characterBudget, input),
      input.maxChars,
      input.maxTokens,
    );
    return {
      ...common,
      view: input.view,
      content: page.content,
      estimatedTokens: page.estimatedTokens,
      nextCursor: page.hasMore
        ? encodeCursor({
            v: 1,
            resourceRef: input.resourceRef,
            view: input.view,
            filterHash: filterHash(input),
            offset: page.nextOffset,
          })
        : null,
    };
  }
}
