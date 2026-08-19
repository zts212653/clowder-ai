import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const LEDGER_FILE_LIMIT = 4 * 1024 * 1024;
export const LEDGER_ENTRY_LIMIT = 2048;
const SAFE_TOKEN = /^[A-Za-z0-9._:-]+$/;
const VALID_STATES = new Set(['accepted', 'extension_received', 'inserted', 'submitted', 'host_observed', 'failed']);

function safeToken(value, maximum) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && SAFE_TOKEN.test(value);
}

export function ledgerKey(conversationId, idempotencyKey) {
  return `${conversationId}\u0000${idempotencyKey}`;
}

export function textDigest(text) {
  return createHash('sha256').update(text).digest('hex');
}

function ledgerPayload(entries) {
  return `${JSON.stringify({ version: 1, entries: [...entries.values()] })}\n`;
}

export function hasCapacityForEntry(entries, entry) {
  if (entries.size >= LEDGER_ENTRY_LIMIT) return false;
  const terminalReservation = new Map(entries);
  terminalReservation.set(ledgerKey(entry.conversationId, entry.idempotencyKey), {
    ...entry,
    state: 'host_observed',
    hostMessageId: 'x'.repeat(512),
  });
  return Buffer.byteLength(ledgerPayload(terminalReservation), 'utf8') <= LEDGER_FILE_LIMIT;
}

export async function writeAtomicLedger(path, entries) {
  const payload = ledgerPayload(entries);
  if (Buffer.byteLength(payload, 'utf8') > LEDGER_FILE_LIMIT) throw new Error('ledger capacity exceeded');
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  await writeFile(temporaryPath, payload, { encoding: 'utf8', mode: 0o600 });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, path);
  await chmod(path, 0o600);
}

export async function loadLedger(path) {
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return new Map();
    throw error;
  }
  if (Buffer.byteLength(raw, 'utf8') > LEDGER_FILE_LIMIT) throw new Error('ledger is too large');
  const parsed = JSON.parse(raw);
  if (parsed?.version !== 1 || !Array.isArray(parsed.entries)) throw new Error('ledger has an unsupported shape');
  const entries = new Map();
  for (const value of parsed.entries) {
    if (!safeToken(value?.conversationId, 200) || !safeToken(value?.idempotencyKey, 512)) {
      throw new Error('ledger contains an invalid key');
    }
    const key = ledgerKey(value.conversationId, value.idempotencyKey);
    if (entries.has(key)) throw new Error('ledger contains a duplicate key');
    if (!VALID_STATES.has(value.state)) throw new Error('ledger contains an invalid state');
    entries.set(key, { ...value });
  }
  return entries;
}
