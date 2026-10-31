import { execFile } from 'node:child_process';
import type { Dir } from 'node:fs';
import { opendir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { humanSessionFirstLine } from '@cat-cafe/shared';
import type { LocalSessionMetadata } from '../../types.js';

const execFileAsync = promisify(execFile);

/** Probe writable descriptors for this exact history file; never scan transcript contents. */
export async function hasClaudeSessionWriter(path: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('lsof', ['-F', 'fa', '--', path], { timeout: 1500, maxBuffer: 65536 });
    return /^a[wu]$/m.test(stdout);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 1) return false;
    throw new Error('Unable to verify the Claude Code session writer');
  }
}

/** Claude Code owns a small live-process registry, separate from conversation history. */
export async function hasClaudeRegisteredSessionWriter(root: string, sessionId: string): Promise<boolean> {
  let directory: Dir;
  try {
    directory = await opendir(join(root, 'sessions'));
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
  let checked = 0;
  for await (const file of directory) {
    if (!file.isFile() || !/^\d+\.json$/.test(file.name)) continue;
    if (++checked > 128) throw new Error('Unable to verify all Claude Code session writers');
    const path = join(root, 'sessions', file.name);
    try {
      if ((await stat(path)).size > 16384) throw new Error('Claude process metadata exceeds its read budget');
      const entry = JSON.parse(await readFile(path, 'utf8')) as { sessionId?: unknown; pid?: unknown };
      if (entry.sessionId !== sessionId || !Number.isSafeInteger(entry.pid) || Number(entry.pid) <= 0) continue;
      try {
        process.kill(Number(entry.pid), 0);
        return true;
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH') continue;
        throw error;
      }
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') continue;
      throw error;
    }
  }
  return false;
}

export async function inspectClaudeLocalSession(sessionId: string): Promise<LocalSessionMetadata> {
  const { getSessionInfo } = await import('@anthropic-ai/claude-agent-sdk');
  const info = await getSessionInfo(sessionId);
  if (!info?.cwd || !info.cwd.startsWith('/'))
    throw new Error('The original Claude Code session metadata is unavailable');
  const root = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  const path = join(root, 'projects', info.cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);
  if ((await hasClaudeRegisteredSessionWriter(root, sessionId)) || (await hasClaudeSessionWriter(path))) {
    throw Object.assign(new Error('This session is running in Claude Code'), { code: 'SESSION_ACTIVE_WRITER' });
  }
  return {
    sessionId: info.sessionId,
    clientId: 'anthropic',
    firstPrompt: humanSessionFirstLine(info.firstPrompt ?? ''),
    projectPath: info.cwd,
    lastActivityAt: info.lastModified,
    turnCount: null,
  };
}
