import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createModuleLogger } from '../../../../../../infrastructure/logger.js';
import type { LSProcessInfo } from './antigravity-ls-discovery.js';

const log = createModuleLogger('antigravity-discovery');

/** Filter incrementally: unrelated long CLI arguments must not exhaust an exec buffer. */
export async function listProcessesViaPs(): Promise<LSProcessInfo[]> {
  const child = spawn('ps', ['-eo', 'pid,args'], {
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 5000,
    killSignal: 'SIGKILL',
  });
  const completion = new Promise<{ code: number | null; error?: Error }>((resolve) => {
    child.once('error', (error) => resolve({ code: null, error }));
    child.once('close', (code) => resolve({ code }));
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const result: LSProcessInfo[] = [];
  try {
    for await (const line of lines) {
      if (!line.includes('language_server') || !line.includes('csrf_token')) continue;
      const match = line.match(/^\s*(\d+)\s+(.*)$/);
      if (match) result.push({ pid: match[1], cmd: match[2] });
    }
    const completed = await completion;
    if (completed.error || completed.code !== 0) {
      log.warn(`ps lookup failed: ${completed.error?.message ?? `exit ${completed.code}`}`);
      return [];
    }
    return result;
  } catch (error) {
    log.warn(`ps lookup failed: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  } finally {
    lines.close();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}
