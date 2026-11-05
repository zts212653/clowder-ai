import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { humanSessionFirstLine, isCatCafeSessionInput, LOCAL_SESSION_CANDIDATE_LIMIT } from '@cat-cafe/shared';
import type { LocalSessionList, LocalSessionMetadata } from '../../types.js';

const MAX_INDEX_BYTES = 2 * 1024 * 1024;
const MAX_ENTRY_BYTES = 65536;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** CLI input-history index only. Never enumerate projects or open a conversation transcript. */
async function readIndexTail(path: string): Promise<{ text: string; complete: boolean }> {
  let file;
  try {
    file = await open(path, 'r');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
      return { text: '', complete: true };
    throw error;
  }
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error('Claude session index is not a regular file');
    const start = Math.max(0, info.size - MAX_INDEX_BYTES);
    const buffer = Buffer.alloc(Math.min(info.size, MAX_INDEX_BYTES));
    let count = 0;
    while (count < buffer.length) {
      const read = await file.read(buffer, count, buffer.length - count, start + count);
      if (!read.bytesRead) break;
      count += read.bytesRead;
    }
    const text = buffer.toString('utf8', 0, count);
    return { text: start ? text.slice(text.indexOf('\n') + 1) : text, complete: start === 0 };
  } finally {
    await file.close();
  }
}

export async function readClaudeRecentSessionIndex(limit: number, configRoot: string): Promise<LocalSessionList> {
  if (!Number.isInteger(limit) || limit < 1 || limit > LOCAL_SESSION_CANDIDATE_LIMIT)
    throw new Error('Invalid recent-session limit');
  const index = await readIndexTail(join(configRoot, 'history.jsonl'));
  const sessions = new Map<string, LocalSessionMetadata & { recentPrompt?: string }>();
  let complete = index.complete;
  const cafeOrigins = new Set<string>();
  let parsed = 0;
  for (const line of index.text.split('\n')) {
    if (++parsed % 128 === 0) await setImmediate();
    if (!line.trim()) continue;
    if (Buffer.byteLength(line, 'utf8') > MAX_ENTRY_BYTES) {
      complete = false;
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      complete = false;
      continue;
    }
    if (!value || typeof value !== 'object') continue;
    const entry = value as Record<string, unknown>;
    if (
      typeof entry.sessionId !== 'string' ||
      !UUID.test(entry.sessionId) ||
      typeof entry.project !== 'string' ||
      !entry.project.startsWith('/') ||
      typeof entry.timestamp !== 'number' ||
      !Number.isFinite(entry.timestamp) ||
      entry.timestamp < 0 ||
      typeof entry.display !== 'string' ||
      !entry.display.trim() ||
      entry.display.trim().startsWith('/')
    )
      continue;
    const prompt = humanSessionFirstLine(entry.display);
    const prior = sessions.get(entry.sessionId);
    if (!prior) {
      if (isCatCafeSessionInput(entry.display)) cafeOrigins.add(entry.sessionId);
      sessions.set(entry.sessionId, {
        sessionId: entry.sessionId,
        clientId: 'anthropic',
        projectPath: entry.project,
        firstPrompt: prompt,
        recentPrompt: prompt,
        lastActivityAt: entry.timestamp,
        turnCount: null,
      });
    } else if (entry.timestamp >= prior.lastActivityAt) {
      if (!prior.firstPrompt && prompt) prior.firstPrompt = prompt;
      prior.recentPrompt = prompt;
      prior.lastActivityAt = entry.timestamp;
      prior.projectPath = entry.project;
    }
  }
  // A bounded tail cannot prove which input started a session. Use first-input
  // evidence only with a complete index; the claim filter still covers known records.
  const ordered = [...sessions.values()]
    .filter((s) => !complete || !cafeOrigins.has(s.sessionId))
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  return {
    sessions: ordered.slice(0, limit).map((s) => ({ ...s, firstPrompt: complete ? s.firstPrompt : '' })),
    limited: !complete || ordered.length > limit,
  };
}
