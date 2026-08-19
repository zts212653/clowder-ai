/**
 * Provider-neutral session-scoped callback credential files.
 *
 * Long-lived provider/MCP processes freeze their environment at spawn time.
 * Each provider session therefore receives a nonce path whose contents are
 * refreshed before resume. The MCP server re-reads that file per callback.
 * Bindings are namespaced by carrier so coincident provider session ids cannot
 * alias one another.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import { findMonorepoRoot } from '../../../../../utils/monorepo-root.js';

const log = createModuleLogger('session-credential-file');
const sessionFileBindings = new Map<string, Map<string, string>>();
const MAX_BINDINGS = 1_000;
const SWEEP_AGE_MS = 48 * 60 * 60 * 1_000;

export interface PreparedCredentialEnv {
  env: Record<string, string>;
  path: string;
}

interface CredentialPayload {
  threadId: string;
  catId: string;
  invocationId: string;
  callbackToken: string;
}

function credentialDir(): string {
  const override = process.env.CAT_CAFE_MCP_CREDS_DIR?.trim();
  if (override) return override;
  return resolve(findMonorepoRoot(process.cwd()), '.cat-cafe', 'mcp-creds');
}

export function resolveSessionCredentialFile(
  namespace: string,
  callbackEnv: Record<string, string> | undefined,
  resumeSessionId?: string,
): PreparedCredentialEnv | null {
  const payload = parseCredentialPayload(callbackEnv);
  if (!callbackEnv || !payload) return null;
  const dir = credentialDir();
  const bound = resumeSessionId ? sessionFileBindings.get(namespace)?.get(resumeSessionId) : undefined;
  const path =
    bound ?? join(dir, `${safePathSegment(payload.threadId)}_${safePathSegment(payload.catId)}_${randomUUID()}.json`);
  return { env: { ...callbackEnv, CAT_CAFE_CREDENTIAL_FILE: path }, path };
}

export function writeSessionCredentialFile(callbackEnv: Record<string, string> | undefined, path: string): boolean {
  const payload = parseCredentialPayload(callbackEnv);
  if (!payload) return false;
  const dir = dirname(path);
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  const serialized = JSON.stringify({
    invocationId: payload.invocationId,
    callbackToken: payload.callbackToken,
    ts: Date.now(),
  });
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(temporaryPath, serialized, { mode: 0o600 });
    try {
      renameSync(temporaryPath, path);
    } catch {
      // Windows cannot always replace an existing destination with rename.
      unlinkSync(temporaryPath);
      writeFileSync(path, serialized, { mode: 0o600 });
    }
    sweepStaleFiles(dir);
    return true;
  } catch (err) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // Best-effort cleanup of an uncommitted temp file.
    }
    log.warn(
      {
        threadId: payload.threadId,
        catId: payload.catId,
        invocationId: payload.invocationId,
        err: err instanceof Error ? err.message : String(err),
      },
      'session credential file write failed',
    );
    return false;
  }
}

export function prepareSessionCredentialFile(
  namespace: string,
  callbackEnv: Record<string, string> | undefined,
  resumeSessionId?: string,
): PreparedCredentialEnv | null {
  const prepared = resolveSessionCredentialFile(namespace, callbackEnv, resumeSessionId);
  if (!prepared) return null;
  if (!writeSessionCredentialFile(callbackEnv, prepared.path)) return null;
  return prepared;
}

export function bindSessionCredentialFile(namespace: string, sessionId: string | undefined, path: string): void {
  if (!sessionId) return;
  let bindings = sessionFileBindings.get(namespace);
  if (!bindings) {
    bindings = new Map();
    sessionFileBindings.set(namespace, bindings);
  }
  if (!bindings.has(sessionId) && bindings.size >= MAX_BINDINGS) {
    const oldest = bindings.keys().next().value;
    if (oldest !== undefined) bindings.delete(oldest);
  }
  bindings.set(sessionId, path);
}

function sweepStaleFiles(dir: string): void {
  try {
    const cutoff = Date.now() - SWEEP_AGE_MS;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const filePath = join(dir, name);
      try {
        if (statSync(filePath).mtimeMs < cutoff) unlinkSync(filePath);
      } catch {
        // Best-effort: another invocation may have removed the file.
      }
    }
  } catch {
    // Sweeping must never break an invocation.
  }
}

function parseCredentialPayload(callbackEnv: Record<string, string> | undefined): CredentialPayload | null {
  const threadId = callbackEnv?.CAT_CAFE_THREAD_ID;
  const catId = callbackEnv?.CAT_CAFE_CAT_ID;
  const invocationId = callbackEnv?.CAT_CAFE_INVOCATION_ID;
  const callbackToken = callbackEnv?.CAT_CAFE_CALLBACK_TOKEN;
  if (!threadId || !catId || !invocationId || !callbackToken) return null;
  return { threadId, catId, invocationId, callbackToken };
}

function safePathSegment(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
  return safe || 'unknown';
}
