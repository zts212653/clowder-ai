import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

async function optional(action, fallback) {
  try {
    return await action();
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}
function journalRows(text) {
  const rows = [],
    lines = text.split('\n');
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index].trim()) continue;
    try {
      rows.push(JSON.parse(lines[index]));
    } catch (error) {
      if (index === lines.length - 1 && !text.endsWith('\n')) break;
      throw error;
    }
  }
  return rows;
}
function collect(rows, threadId, cat, desired, events) {
  for (const row of rows) {
    if (row.threadId !== threadId || row.catId !== cat || desired.get(row.invocationId) !== cat) continue;
    const event = row.event;
    if (!['tool_use', 'tool_result'].includes(event?.type) || event.catId !== cat) continue;
    if (!events.has(row.invocationId)) events.set(row.invocationId, []);
    events.get(row.invocationId).push({
      type: event.type,
      toolName: event.toolName,
      toolUseId: event.toolUseId,
      timestamp: event.timestamp,
      status: event.toolResultStatus,
      detail: event.content,
    });
  }
}
async function readJournal(root, file) {
  const real = await optional(() => fs.realpath(file), null);
  if (!real) return null;
  assert.ok(real.startsWith(root + path.sep), 'Transcript escaped the owned instance');
  const text = await fs.readFile(real, 'utf8');
  return {
    rows: journalRows(text),
    source: {
      path: path.relative(root, real).replaceAll('\\', '/'),
      sha256: createHash('sha256').update(text).digest('hex'),
    },
  };
}
// UI details deliberately truncate at 1500 chars. Read the exact, complete
// journal without changing display limits or manufacturing missing evidence.
export async function readNativeToolObservations(instance, threadId, messages) {
  const events = new Map(),
    sources = [];
  if (!instance) return { events, sources };
  assert.ok(path.isAbsolute(instance));
  assert.match(threadId, /^[a-zA-Z0-9_-]+$/);
  const root = await fs.realpath(instance);
  const desired = new Map(
    messages
      .filter((m) => m.type === 'assistant' && m.lifecycle?.invocationId && typeof m.catId === 'string')
      .map((m) => [m.lifecycle.invocationId, m.catId]),
  );
  for (const cat of new Set(desired.values())) {
    assert.match(cat, /^[a-zA-Z0-9_-]+$/);
    const sessions = path.join(root, 'data/transcripts/threads', threadId, cat, 'sessions');
    const directories = await optional(() => fs.readdir(sessions, { withFileTypes: true }), []);
    for (const directory of directories) {
      if (!directory.isDirectory() || directory.isSymbolicLink()) continue;
      const journal = await readJournal(root, path.join(sessions, directory.name, 'events.live.jsonl'));
      if (!journal) continue;
      collect(journal.rows, threadId, cat, desired, events);
      sources.push(journal.source);
    }
  }
  return { events, sources };
}
