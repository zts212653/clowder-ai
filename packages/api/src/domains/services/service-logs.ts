import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');

export function resolveRepoRoot(): string {
  return REPO_ROOT;
}

const MODEL_ID_PATTERN = /^[a-zA-Z0-9_-]+\/[a-zA-Z0-9._-]+$/;

export function isValidModelId(model: string): boolean {
  return MODEL_ID_PATTERN.test(model) && model.length <= 200;
}

export function resolveScriptPath(script: string): string {
  return resolve(REPO_ROOT, script);
}

function resolveLogDir(): string {
  return process.env['LOG_DIR'] ?? resolve(REPO_ROOT, 'data/logs/api');
}

export function readLogTail(serviceId: string, lines = 100): string[] {
  const logPath = resolve(resolveLogDir(), `${serviceId}.log`);
  if (!existsSync(logPath)) return [];
  try {
    const fd = openSync(logPath, 'r');
    try {
      const stat = fstatSync(fd);
      const maxRead = 256 * 1024;
      const readSize = Math.min(stat.size, maxRead);
      if (readSize === 0) return [];
      const buf = Buffer.alloc(readSize);
      readSync(fd, buf, 0, readSize, Math.max(0, stat.size - readSize));
      return buf.toString('utf-8').split('\n').slice(-lines).filter(Boolean);
    } finally {
      closeSync(fd);
    }
  } catch {
    return [];
  }
}

export function openLogFd(serviceId: string): number | null {
  try {
    const logDir = resolveLogDir();
    mkdirSync(logDir, { recursive: true });
    return openSync(resolve(logDir, `${serviceId}.log`), 'a');
  } catch {
    return null;
  }
}

export function appendLog(serviceId: string, chunk: string): void {
  try {
    const logDir = resolveLogDir();
    mkdirSync(logDir, { recursive: true });
    appendFileSync(resolve(logDir, `${serviceId}.log`), chunk);
  } catch {
    /* best effort */
  }
}
