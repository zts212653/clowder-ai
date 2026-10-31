import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { readOpenCodeLocalSessions } from './OpenCodeLocalSessionIndex.js';

const execFileAsync = promisify(execFile);
const UNFINISHED_TURN_RECENCY_MS = 10 * 60_000;

export function hasOpenCodeSessionProcess(output: string, sessionId: string): boolean {
  return output.split('\n').some((line) => {
    const words = line.trim().split(/\s+/);
    if (!words.some((word) => /(?:^|\/)opencode$/.test(word))) return false;
    return words.some(
      (word, index) =>
        ((word === '--session' || word === '-s') && words[index + 1] === sessionId) ||
        word === `--session=${sessionId}`,
    );
  });
}

export async function inspectOpenCodeLocalSession(path: string, sessionId: string) {
  const session = readOpenCodeLocalSessions(path, { sessionId }).sessions[0];
  const { stdout } = await execFileAsync('ps', ['-axo', 'command='], { timeout: 1500, maxBuffer: 4 * 1024 * 1024 });
  if (hasOpenCodeSessionProcess(stdout, sessionId))
    throw Object.assign(new Error('This session is running in OpenCode'), { code: 'SESSION_ACTIVE_WRITER' });
  // A Desktop/server writer has no --session argv. Its latest unfinished assistant
  // metadata is only a recent-activity heuristic. Old interrupted turns are not
  // live-writer proof; exact --session processes above remain busy regardless of age.
  const db = new Database(path, { readonly: true, fileMustExist: true, timeout: 1000 });
  try {
    const row = db
      .prepare(
        "SELECT time_updated AS updatedAt, json_extract(data, '$.time.completed') AS completed FROM message WHERE session_id = ? AND json_extract(data, '$.role') = 'assistant' ORDER BY time_created DESC LIMIT 1",
      )
      .get(sessionId) as { updatedAt: number; completed: number | null } | undefined;
    if (
      row?.completed === null &&
      Math.max(row.updatedAt, session.lastActivityAt) >= Date.now() - UNFINISHED_TURN_RECENCY_MS
    )
      throw Object.assign(new Error('This OpenCode session has a recently active unfinished turn'), {
        code: 'SESSION_ACTIVE_WRITER',
      });
  } finally {
    db.close();
  }
  return session;
}
