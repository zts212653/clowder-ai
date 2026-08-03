import { createReadStream } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import {
  extractRecoveryEntryFromEvents,
  type RecoveryManifestEntry,
  type RecoveryTranscriptEvent,
} from './manifest.js';

export interface RecoveryTranscriptTarget {
  invocationId: string;
  userId: string;
  withheldDecision?: {
    withheldAtUtc: string;
    closureId: string;
    decisionKind: string;
  };
}

interface TranscriptCandidate {
  file: string;
  priority: number;
  events: RecoveryTranscriptEvent[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseTargetEvent(line: string): RecoveryTranscriptEvent {
  const value: unknown = JSON.parse(line);
  if (
    !isRecord(value) ||
    typeof value.v !== 'number' ||
    typeof value.t !== 'number' ||
    typeof value.threadId !== 'string' ||
    typeof value.catId !== 'string' ||
    typeof value.sessionId !== 'string' ||
    typeof value.cliSessionId !== 'string' ||
    typeof value.invocationId !== 'string' ||
    typeof value.eventNo !== 'number' ||
    !isRecord(value.event)
  ) {
    throw new Error('target transcript line does not match the unified event schema');
  }
  return {
    v: value.v,
    t: value.t,
    threadId: value.threadId,
    catId: value.catId,
    sessionId: value.sessionId,
    cliSessionId: value.cliSessionId,
    invocationId: value.invocationId,
    eventNo: value.eventNo,
    event: value.event,
  };
}

function invocationIdFromLine(line: string): string | undefined {
  return /"invocationId"\s*:\s*"([^"]+)"/u.exec(line)?.[1];
}

function sourcePath(sourceRoot: string, file: string): string {
  const path = relative(resolve(sourceRoot), resolve(file));
  if (!path || path === '..' || path.startsWith(`..${sep}`)) {
    throw new Error(`transcript file is outside sourceRoot: ${file}`);
  }
  return path.split(sep).join('/');
}

function transcriptPriority(file: string): number {
  return file.endsWith('/events.jsonl') || file.endsWith(`${sep}events.jsonl`) ? 2 : 1;
}

async function scanFile(file: string, targetIds: ReadonlySet<string>): Promise<Map<string, RecoveryTranscriptEvent[]>> {
  const found = new Map<string, RecoveryTranscriptEvent[]>();
  const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) {
    const invocationId = invocationIdFromLine(line);
    if (!invocationId || !targetIds.has(invocationId)) continue;
    const event = parseTargetEvent(line);
    const events = found.get(invocationId) ?? [];
    events.push(event);
    found.set(invocationId, events);
  }
  return found;
}

function selectEntry(
  target: RecoveryTranscriptTarget,
  candidates: readonly TranscriptCandidate[],
  sourceRoot: string,
): { kind: 'entry'; entry: RecoveryManifestEntry } | { kind: 'no_text' } | { kind: 'missing' } {
  const complete: Array<{ entry: RecoveryManifestEntry; priority: number; file: string }> = [];
  for (const candidate of candidates) {
    try {
      complete.push({
        entry: extractRecoveryEntryFromEvents({
          invocationId: target.invocationId,
          userId: target.userId,
          transcriptPath: sourcePath(sourceRoot, candidate.file),
          events: candidate.events,
          ...(target.withheldDecision ? { withheldDecision: target.withheldDecision } : {}),
        }),
        priority: candidate.priority,
        file: candidate.file,
      });
    } catch {
      // A live file can be partial while a sealed file is complete. Missing is
      // reported only after every candidate fails the completeness contract.
    }
  }
  if (complete.length === 0) {
    const hasRecoverableText = candidates.some((candidate) =>
      candidate.events.some(
        ({ event }) =>
          (event.type === 'text' && typeof event.content === 'string' && event.content.length > 0) ||
          (event.type === 'assistant' &&
            (typeof event.content === 'string' ||
              (Array.isArray(event.content) &&
                event.content.some(
                  (part) =>
                    typeof part === 'object' &&
                    part !== null &&
                    'type' in part &&
                    part.type === 'text' &&
                    'text' in part &&
                    typeof part.text === 'string' &&
                    part.text.length > 0,
                )))),
      ),
    );
    return candidates.length > 0 && !hasRecoverableText ? { kind: 'no_text' } : { kind: 'missing' };
  }
  const bestPriority = Math.max(...complete.map((candidate) => candidate.priority));
  const best = complete
    .filter((candidate) => candidate.priority === bestPriority)
    .sort((a, b) => a.file.localeCompare(b.file));
  const selected = best[0];
  if (!selected) throw new Error(`no complete transcript candidate for invocation ${target.invocationId}`);
  for (const candidate of best.slice(1)) {
    if (
      candidate.entry.threadId !== selected.entry.threadId ||
      candidate.entry.catId !== selected.entry.catId ||
      candidate.entry.contentSha256 !== selected.entry.contentSha256
    ) {
      throw new Error(`conflicting complete transcripts for invocation ${target.invocationId}`);
    }
  }
  return { kind: 'entry', entry: selected.entry };
}

export async function scanRecoveryTranscriptFiles(input: {
  targets: readonly RecoveryTranscriptTarget[];
  files: readonly string[];
  sourceRoot: string;
}): Promise<{ entries: RecoveryManifestEntry[]; omittedNoTextInvocations: string[]; scannedFiles: number }> {
  const targets = new Map<string, RecoveryTranscriptTarget>();
  for (const target of input.targets) {
    if (targets.has(target.invocationId)) throw new Error(`duplicate transcript target: ${target.invocationId}`);
    targets.set(target.invocationId, target);
  }
  const candidates = new Map<string, TranscriptCandidate[]>();
  for (const file of [...input.files].sort()) {
    const found = await scanFile(file, new Set(targets.keys()));
    for (const [invocationId, events] of found) {
      const list = candidates.get(invocationId) ?? [];
      list.push({ file, priority: transcriptPriority(file), events });
      candidates.set(invocationId, list);
    }
  }
  const entries: RecoveryManifestEntry[] = [];
  const omittedNoTextInvocations: string[] = [];
  const missing: string[] = [];
  for (const target of targets.values()) {
    const selection = selectEntry(target, candidates.get(target.invocationId) ?? [], input.sourceRoot);
    if (selection.kind === 'entry') entries.push(selection.entry);
    else if (selection.kind === 'no_text') omittedNoTextInvocations.push(target.invocationId);
    else missing.push(target.invocationId);
  }
  if (missing.length > 0) throw new Error(`missing complete transcripts: ${missing.sort().join(', ')}`);
  return {
    entries: entries.sort((a, b) => a.invocationId.localeCompare(b.invocationId)),
    omittedNoTextInvocations: omittedNoTextInvocations.sort(),
    scannedFiles: input.files.length,
  };
}
