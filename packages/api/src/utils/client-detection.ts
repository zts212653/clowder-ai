/**
 * Client Detection — detect which CLI clients are available in the system.
 *
 * Runs detection once at startup time and caches the result.
 * Each client maps to a CLI command (e.g. anthropic → claude, openai → codex).
 */

import { execFile } from 'node:child_process';
import { jiuwenClawBundleAvailable } from './jiuwenclaw-paths.js';

type ClientId = 'anthropic' | 'openai' | 'google' | 'dare' | 'opencode' | 'antigravity' | 'relayclaw';

interface ClientInfo {
  id: ClientId;
  label: string;
  command: string;
}

const CLIENT_COMMAND_MAP: ClientInfo[] = [
  { id: 'anthropic', label: 'Claude', command: 'claude' },
  { id: 'openai', label: 'Codex', command: 'codex' },
  { id: 'google', label: 'Gemini', command: 'gemini' },
  { id: 'dare', label: 'Dare', command: 'dare' },
  { id: 'opencode', label: 'OpenCode', command: 'opencode' },
  { id: 'antigravity', label: 'Antigravity', command: 'antigravity' },
  { id: 'relayclaw', label: 'jiuwenClaw', command: 'jiuwenclaw-app' },
];

export interface AvailableClient {
  id: ClientId;
  label: string;
  command: string;
  available: boolean;
}

let cachedClients: AvailableClient[] | null = null;

function commandExists(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('which', [command], (error) => {
      resolve(!error);
    });
  });
}

function relayClawSidecarAvailable(): boolean {
  return jiuwenClawBundleAvailable();
}

/** Detect all clients and cache the result. */
export async function detectAvailableClients(): Promise<AvailableClient[]> {
  const results = await Promise.all(
    CLIENT_COMMAND_MAP.map(async (info) => {
      const available = info.id === 'relayclaw' ? relayClawSidecarAvailable() : await commandExists(info.command);
      return {
        id: info.id,
        label: info.label,
        command: info.command,
        available,
      };
    }),
  );
  cachedClients = results;
  return results;
}

/** Return cached detection results (runs detection if not yet cached). */
export async function getAvailableClients(): Promise<AvailableClient[]> {
  if (cachedClients) return cachedClients;
  return detectAvailableClients();
}

/** Force re-detection (useful if user installs a CLI after startup). */
export async function refreshAvailableClients(): Promise<AvailableClient[]> {
  cachedClients = null;
  return detectAvailableClients();
}
