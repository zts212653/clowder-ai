import { closeSync, constants, mkdirSync, openSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { redactSecretContent } from './lib/secret-content-scan.mjs';

function summary(value, limit = 240) {
  try {
    return redactSecretContent(String(value ?? ''))
      .replace(/[\r\n\t]/g, ' ')
      .slice(0, limit);
  } catch {
    return '[summary unavailable]';
  }
}

function appendLocalRecord(homeDir, entry) {
  const directory = join(homeDir, '.cat-cafe', 'guard-denials');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const descriptor = openSync(
    join(directory, 'native.jsonl'),
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeSync(descriptor, `${JSON.stringify(entry)}\n`);
  } finally {
    closeSync(descriptor);
  }
}

/** Actual hook entries call this; pure policy probes never write an audit. */
export function appendNativeDenial(
  payload,
  verdict,
  { homeDir = homedir(), append = appendLocalRecord, warn = (message) => process.stderr.write(message) } = {},
) {
  if (verdict.decision !== 'deny') return;
  const input = payload?.tool_input ?? {};
  const command = input.command ?? input.cmd ?? input.patch ?? input.file_path ?? payload?.tool_name;
  try {
    append(homeDir, {
      at: new Date().toISOString(),
      catId: process.env.CAT_CAFE_CAT_ID ?? 'unknown',
      origin: process.env.NODE_TEST_CONTEXT ? 'test_process' : 'native_hook',
      provider: ['codex', 'claude', 'agy'].includes(verdict.source?.provider)
        ? verdict.source.provider
        : payload?.turn_id || payload?.tool_use_id
          ? 'codex'
          : 'claude',
      reasonCode: verdict.reasonCode,
      effect: verdict.effect,
      target: { kind: verdict.target?.kind, value: summary(verdict.target?.value, 1024) },
      commandSummary: summary(command),
    });
  } catch {
    warn('Clowder AI guard: local denial audit unavailable\n');
  }
}

export function guardReason(verdict) {
  const target = summary(verdict.target.value, 1024);
  return `Clowder AI native guard: ${verdict.reasonCode} (${verdict.effect} → ${verdict.target.kind}: ${target})${verdict.detail ? ` — ${summary(verdict.detail, 1024)}` : ''}`;
}
