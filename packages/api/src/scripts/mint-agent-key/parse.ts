/**
 * mint-agent-key — CLI argv parsing + sanctuary URL detection + cat allowlist loader.
 */

import { DEFAULT_USER_ID, defaultKeyFile, type ParseError, type ParseResult, SANCTUARY_REDIS_PORT } from './types.js';

// ============ Flag parsing ============

type FlagsMap = Record<string, string | boolean>;
const BOOLEAN_FLAGS = new Set(['execute', 'i-understand-runtime-redis']);
const VALUE_FLAGS = new Set(['cat-id', 'redis-url', 'user-id', 'key-file']);
const KNOWN_FLAGS = new Set([...BOOLEAN_FLAGS, ...VALUE_FLAGS]);

function tokenizeArgv(argv: readonly string[]): { flags: FlagsMap } | ParseError {
  const flags: FlagsMap = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) return { error: `Unexpected positional argument: ${arg}` };
    const key = arg.slice(2);
    if (!KNOWN_FLAGS.has(key)) {
      return { error: `Unknown flag: --${key}. Known flags: ${[...KNOWN_FLAGS].sort().join(', ')}` };
    }
    if (BOOLEAN_FLAGS.has(key)) {
      flags[key] = true;
      continue;
    }
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) return { error: `Missing value for --${key}` };
    flags[key] = next;
    i++;
  }
  return { flags };
}

function pickString(flags: FlagsMap, key: string): string | null {
  const v = flags[key];
  return typeof v === 'string' && v ? v : null;
}

/**
 * Parse argv into MintArgs or ParseError. Strict: no positional args, no
 * unknown flags, all values must follow a `--flag`.
 */
export function parseMintArgs(argv: readonly string[]): ParseResult {
  const tokenized = tokenizeArgv(argv);
  if ('error' in tokenized) return tokenized;
  const { flags } = tokenized;
  const catId = pickString(flags, 'cat-id');
  if (!catId) return { error: 'Missing required flag: --cat-id <id>' };
  const redisUrl = pickString(flags, 'redis-url');
  if (!redisUrl) {
    return { error: 'Missing required flag: --redis-url <url> (no default; explicit to avoid silent 6399 hit)' };
  }
  return {
    catId,
    redisUrl,
    execute: flags.execute === true,
    userId: pickString(flags, 'user-id') ?? DEFAULT_USER_ID,
    keyFile: pickString(flags, 'key-file') ?? defaultKeyFile(catId),
    iUnderstandRuntimeRedis: flags['i-understand-runtime-redis'] === true,
  };
}

// ============ Sanctuary URL detection ============

/**
 * Returns true iff the URL targets the sanctuary Redis port (6399). The
 * acknowledgement flag is required for ANY host on this port — including
 * non-loopback hostnames (e.g. runtime DNS alias like `redis.cat-cafe.internal:6399`).
 *
 * Earlier version limited the guard to loopback hosts (127.0.0.1 / localhost /
 * ::1), but cloud codex review 2026-06-13 P1 flagged: if runtime sanctuary
 * Redis is reachable via a non-loopback alias, the loopback-only guard lets
 * admins `--execute` against it without explicit ack, defeating the entire
 * "triple-explicit safety" contract. CLI usage docs say "required iff URL
 * targets 6399" — that has to mean ANY 6399, not just localhost 6399.
 */
export function isSanctuaryRedisUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const port = u.port || (u.protocol === 'rediss:' ? '6380' : '6379');
    return port === SANCTUARY_REDIS_PORT;
  } catch {
    return false;
  }
}

// ============ catId allowlist ============

interface CatConfigRoster {
  roster?: Record<string, unknown>;
}

/**
 * Load the catId allowlist from cat-config.json roster keys.
 * Fail-closed: file missing/unparseable → throw (no default allowlist).
 */
export async function loadCatIdAllowlistFromConfig(configPath: string): Promise<Set<string>> {
  const { readFile } = await import('node:fs/promises');
  const raw = await readFile(configPath, 'utf8');
  const parsed = JSON.parse(raw) as CatConfigRoster;
  if (!parsed || typeof parsed !== 'object' || !parsed.roster || typeof parsed.roster !== 'object') {
    throw new Error(`Invalid cat-config.json: missing 'roster' object`);
  }
  return new Set(Object.keys(parsed.roster));
}
