import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * F212 Phase H AC-H10 R2 P1-B: strict match on the real route-serial persistence shape.
 *
 * Real F212 error messages are appended by route-serial with:
 *   - userId === 'system'
 *   - catId === null
 *   - content starts with 'Error:' (isLegacyError contract)
 *   - metadata.cliDiagnostics.debugRef.invocationId === <this invocation>
 *
 * OR the legacy fallback: system row with Error: prefix and invocationId
 * substring in content.
 *
 * NON-error rows (chat messages, system_info diagnostics, warnings) whose
 * metadata happens to carry the invocationId MUST NOT satisfy the invariant.
 */
export function isPersistedF212ErrorFor(record, invocationId) {
  if (!record || record.userId !== 'system' || record.catId !== null) return false;
  if (typeof record.content !== 'string' || !record.content.startsWith('Error:')) return false;
  const debugInvocationId = record?.metadata?.cliDiagnostics?.debugRef?.invocationId;
  if (debugInvocationId === invocationId) return true;
  if (record.content.includes(invocationId)) return true;
  return false;
}

/**
 * F212 Phase H AC-H10 R2 P1-A #1: message-store scanner supporting BOTH
 * directory-of-JSONL-shards (production) AND single-file JSONL export
 * (test/repro). Fails closed if the path does not exist.
 *
 * Returns { ok: boolean, found: boolean, reason?: string }.
 */
export function messageStoreHasErrorFor(messageStorePath, invocationId) {
  if (!existsSync(messageStorePath)) {
    return { ok: false, found: false, reason: `message store path does not exist: ${messageStorePath}` };
  }

  const files = [];
  const stat = statSync(messageStorePath);
  if (stat.isDirectory()) {
    for (const dirent of readdirSync(messageStorePath, { withFileTypes: true })) {
      if (dirent.isFile() && dirent.name.endsWith('.jsonl')) {
        files.push(join(messageStorePath, dirent.name));
      }
    }
  } else if (stat.isFile()) {
    files.push(messageStorePath);
  } else {
    return { ok: false, found: false, reason: `message store is neither file nor directory: ${messageStorePath}` };
  }

  for (const file of files) {
    const raw = readFileSync(file, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (isPersistedF212ErrorFor(record, invocationId)) return { ok: true, found: true };
    }
  }
  return { ok: true, found: false };
}
