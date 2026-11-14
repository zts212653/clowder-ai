import { closeSync, constants, mkdirSync, openSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { redactSecretContent } from './lib/secret-content-scan.mjs';
import { NATIVE_AUTH_DENIAL } from './native-auth-effect.mjs';

function summary(value, limit = 240) {
  return boundedSummary(value, limit).value;
}

function boundedSummary(value, limit, preserveLines = false) {
  try {
    const redacted = redactSecretContent(String(value ?? ''));
    const text = preserveLines ? redacted : redacted.replace(/[\r\n\t]/g, ' ');
    return { value: text.slice(0, limit), truncated: text.length > limit };
  } catch {
    return { value: '[summary unavailable]', truncated: true };
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
    const head = boundedSummary(command, 240);
    const clause = boundedSummary(verdict.offendingClause ?? command, 4096, true);
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
      commandSummary: head.value,
      commandSummaryTruncated: head.truncated,
      cwd: summary(verdict.source?.cwd ?? payload?.cwd, 2048),
      offendingClause: clause.value,
      offendingClauseTruncated: clause.truncated,
      offendingClauseSource: verdict.offendingClause ? 'parsed_segment' : 'whole_command',
    });
  } catch {
    warn('Clowder AI guard: local denial audit unavailable\n');
  }
}

export function guardReason(verdict) {
  if (verdict.reasonCode === 'native_auth_mutation') return NATIVE_AUTH_DENIAL;
  const target = summary(verdict.target.value, 1024);
  return `Clowder AI native guard: ${verdict.reasonCode} (${verdict.effect} → ${verdict.target.kind}: ${target})${verdict.detail ? ` — ${summary(verdict.detail, 1024)}` : ''}`;
}
