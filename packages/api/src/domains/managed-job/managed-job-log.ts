import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { sanitizeCliStderr } from '../../utils/sanitize-cli-stderr.js';

function boundedLog(path: string): Buffer {
  if (statSync(path).size > 10 * 1024 * 1024) throw new Error('managed_job_log_size_exceeded');
  return readFileSync(path);
}

export function readManagedJobLogTail(path: string, maxBytes = 16_384): string {
  // Redact before truncating so a boundary cannot remove a credential's identifying prefix.
  const sanitized = Buffer.from(sanitizeCliStderr(boundedLog(path).toString('utf8')));
  return sanitized.subarray(Math.max(0, sanitized.length - maxBytes)).toString('utf8');
}

export function managedJobLogReceipt(path: string) {
  const bytes = boundedLog(path);
  return { path, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
}
