import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const INVALID_THINKING_SIGNATURE_RE = /Invalid [`'"]?signature[`'"]? in [`'"]?thinking[`'"]? block/i;

export interface BrokenClaudeThinkingSession {
  sessionId: string;
  transcriptPath: string;
  removableThinkingTurns: number;
  detectedBy: 'api_error_entry' | 'short_signature';
}

export interface ClaudeThinkingRescueScanResult {
  sessions: BrokenClaudeThinkingSession[];
}

export interface ClaudeThinkingRescueTarget {
  sessionId: string;
  transcriptPath: string;
}

export interface ClaudeThinkingRescueEntryResult {
  sessionId: string;
  status: 'repaired' | 'clean' | 'missing';
  removedTurns: number;
  backupPath: string | null;
  reason?: string;
}

export interface ClaudeThinkingRescueRunResult {
  status: 'ok' | 'partial' | 'noop';
  rescuedCount: number;
  skippedCount: number;
  results: ClaudeThinkingRescueEntryResult[];
}

export interface ClaudeThinkingRescueOptions {
  rootDir?: string;
  backupDir?: string;
  now?: number;
  dryRun?: boolean;
}

/**
 * Signatures from official Anthropic API are variable-length and typically > 400 bytes.
 * Third-party gateways (or CLI internal thinking) may produce short stub signatures
 * (e.g. 212 bytes) that fail verification on --resume. Detect these proactively.
 */
const MIN_VALID_SIGNATURE_LENGTH = 300;

export function hasShortThinkingSignature(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object') return false;
  const candidate = entry as {
    type?: unknown;
    message?: { role?: unknown; content?: unknown };
  };
  if (candidate.type !== 'assistant') return false;
  if (!candidate.message || typeof candidate.message !== 'object') return false;
  if (candidate.message.role !== 'assistant') return false;
  const { content } = candidate.message;
  if (!Array.isArray(content)) return false;
  return content.some(
    (item) =>
      item &&
      typeof item === 'object' &&
      'type' in item &&
      item.type === 'thinking' &&
      'signature' in item &&
      typeof item.signature === 'string' &&
      item.signature.length < MIN_VALID_SIGNATURE_LENGTH,
  );
}

interface ParsedTranscriptScan {
  hasApiErrorEntry: boolean;
  hasShortSignature: boolean;
  removableThinkingTurns: number;
}

export function defaultClaudeProjectsRoot(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

export function defaultClaudeBackupDir(): string {
  return path.join(os.homedir(), '.claude', 'backups');
}

export function isPureThinkingAssistantTurn(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object') return false;
  const candidate = entry as {
    type?: unknown;
    message?: { role?: unknown; content?: unknown };
  };
  if (candidate.type !== 'assistant') return false;
  if (!candidate.message || typeof candidate.message !== 'object') return false;
  if (candidate.message.role !== 'assistant') return false;
  const { content } = candidate.message;
  return (
    Array.isArray(content) &&
    content.length > 0 &&
    content.every(
      (item) =>
        item &&
        typeof item === 'object' &&
        'type' in item &&
        item.type === 'thinking' &&
        'signature' in item &&
        typeof item.signature === 'string',
    )
  );
}

export function stripPureThinkingAssistantTurns(rawContent: string): { content: string; removedCount: number } {
  const lines = rawContent.split('\n');
  const keptLines: string[] = [];
  let removedCount = 0;

  for (const line of lines) {
    if (line.trim().length === 0) {
      keptLines.push(line);
      continue;
    }

    try {
      const parsed = JSON.parse(line) as unknown;
      if (isPureThinkingAssistantTurn(parsed)) {
        removedCount++;
        continue;
      }
    } catch {
      // Keep malformed lines untouched; rescue only removes known-safe pure thinking turns.
    }

    keptLines.push(line);
  }

  return {
    content: keptLines.join('\n'),
    removedCount,
  };
}

function isThinkingSignatureApiErrorEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object') return false;
  const candidate = entry as {
    type?: unknown;
    isApiErrorMessage?: unknown;
    message?: { role?: unknown; content?: unknown };
  };
  if (candidate.type !== 'assistant') return false;
  if (candidate.isApiErrorMessage !== true) return false;
  if (!candidate.message || typeof candidate.message !== 'object') return false;
  if (candidate.message.role !== 'assistant') return false;
  if (!Array.isArray(candidate.message.content)) return false;

  return candidate.message.content.some((item) => {
    if (!item || typeof item !== 'object') return false;
    if (!('type' in item) || item.type !== 'text') return false;
    if (!('text' in item) || typeof item.text !== 'string') return false;
    return INVALID_THINKING_SIGNATURE_RE.test(item.text);
  });
}

function scanTranscript(rawContent: string): ParsedTranscriptScan {
  let hasApiErrorEntry = false;
  let hasShortSignature = false;
  let removableThinkingTurns = 0;

  for (const line of rawContent.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isPureThinkingAssistantTurn(parsed)) removableThinkingTurns++;
      if (isThinkingSignatureApiErrorEntry(parsed)) hasApiErrorEntry = true;
      if (hasShortThinkingSignature(parsed)) hasShortSignature = true;
    } catch {
      // Ignore malformed lines while scanning; they are not rescue targets.
    }
  }

  return { hasApiErrorEntry, hasShortSignature, removableThinkingTurns };
}

async function walkJsonlFiles(rootDir: string): Promise<string[]> {
  const results: string[] = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) results.push(fullPath);
    }
  }

  return results.sort();
}

function backupPathFor(sessionId: string, backupDir: string, now: number): string {
  const unixSeconds = Math.floor(now / 1000);
  return path.join(backupDir, `${sessionId}.pre-strip-thinking-${unixSeconds}.jsonl`);
}

async function repairTranscriptFile(
  target: ClaudeThinkingRescueTarget,
  opts: Required<Pick<ClaudeThinkingRescueOptions, 'backupDir' | 'dryRun' | 'now'>>,
): Promise<ClaudeThinkingRescueEntryResult> {
  let original: string;
  try {
    original = await fs.readFile(target.transcriptPath, 'utf8');
  } catch {
    return {
      sessionId: target.sessionId,
      status: 'missing',
      removedTurns: 0,
      backupPath: null,
      reason: 'transcript_unreadable',
    };
  }

  const stripped = stripPureThinkingAssistantTurns(original);
  if (stripped.removedCount === 0) {
    return {
      sessionId: target.sessionId,
      status: 'clean',
      removedTurns: 0,
      backupPath: null,
    };
  }

  const backupPath = backupPathFor(target.sessionId, opts.backupDir, opts.now);
  if (!opts.dryRun) {
    await fs.mkdir(opts.backupDir, { recursive: true });
    await fs.copyFile(target.transcriptPath, backupPath);
    await fs.writeFile(target.transcriptPath, stripped.content, 'utf8');
  }

  return {
    sessionId: target.sessionId,
    status: 'repaired',
    removedTurns: stripped.removedCount,
    backupPath,
  };
}

export async function findBrokenClaudeThinkingSessions(
  opts: Pick<ClaudeThinkingRescueOptions, 'rootDir'> = {},
): Promise<ClaudeThinkingRescueScanResult> {
  const rootDir = opts.rootDir ?? defaultClaudeProjectsRoot();
  const files = await walkJsonlFiles(rootDir);
  const sessions: BrokenClaudeThinkingSession[] = [];

  for (const transcriptPath of files) {
    let content: string;
    try {
      content = await fs.readFile(transcriptPath, 'utf8');
    } catch {
      continue;
    }

    const scan = scanTranscript(content);
    if (!scan.hasApiErrorEntry && !scan.hasShortSignature) continue;

    sessions.push({
      sessionId: path.basename(transcriptPath, '.jsonl'),
      transcriptPath,
      removableThinkingTurns: scan.removableThinkingTurns,
      detectedBy: scan.hasApiErrorEntry ? 'api_error_entry' : 'short_signature',
    });
  }

  return { sessions };
}

export async function rescueClaudeThinkingSessions(
  opts: ClaudeThinkingRescueOptions & { targets: ClaudeThinkingRescueTarget[] },
): Promise<ClaudeThinkingRescueRunResult> {
  const backupDir = opts.backupDir ?? defaultClaudeBackupDir();
  const now = opts.now ?? Date.now();
  const dryRun = opts.dryRun ?? false;

  const results: ClaudeThinkingRescueEntryResult[] = [];
  for (const target of opts.targets) {
    results.push(await repairTranscriptFile(target, { backupDir, now, dryRun }));
  }

  const rescuedCount = results.filter((result) => result.status === 'repaired').length;
  const skippedCount = results.filter((result) => result.status !== 'repaired').length;
  const status = rescuedCount > 0 ? (skippedCount > 0 ? 'partial' : 'ok') : 'noop';

  return {
    status,
    rescuedCount,
    skippedCount,
    results,
  };
}
