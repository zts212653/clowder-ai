// F198 Phase C AC-C4: agent-sessions-reader
// Reads ~/.claude/jobs/<shortId>/state.json, returns aggregated session snapshots.
// Used by GET /api/agent-sessions to power the Hub Oversight deep-dive view.
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_JOBS_DIR = join(homedir(), '.claude/jobs');

export interface AgentSessionSnapshot {
  daemonShortId: string;
  state: string;
  detail?: string;
  cwd?: string;
  createdAt?: string;
  updatedAt?: string;
}

export async function readAgentSessions(jobsDir?: string): Promise<AgentSessionSnapshot[]> {
  const dir = jobsDir ?? DEFAULT_JOBS_DIR;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const sessions: AgentSessionSnapshot[] = [];
  for (const entry of entries) {
    const statePath = join(dir, entry, 'state.json');
    try {
      await stat(join(dir, entry)); // ensure it's a dir
      const raw = await readFile(statePath, 'utf-8');
      const parsed = JSON.parse(raw);
      sessions.push({
        daemonShortId: (parsed.daemonShort as string | undefined) ?? entry,
        state: (parsed.state as string | undefined) ?? 'unknown',
        detail: parsed.detail as string | undefined,
        cwd: parsed.cwd as string | undefined,
        createdAt: parsed.createdAt as string | undefined,
        updatedAt: parsed.updatedAt as string | undefined,
      });
    } catch {
      // Skip missing state.json or malformed JSON
    }
  }
  return sessions;
}
