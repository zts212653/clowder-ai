/**
 * Unified data directory resolver — issue #671.
 *
 * Three root env vars control where runtime data is written:
 * - DATA_DIR  : persistent data (DBs, transcripts, audit logs, uploads, cli archive)
 * - CACHE_DIR : rebuildable cache (tts audio, connector media)
 * - LOG_DIR   : log files (used directly, no subdirectory)
 *
 * Behavior: if a root is set, the path is `{root}/{subPath}`; otherwise the
 * legacy default (preserved for backward compatibility) is used.
 *
 * Legacy per-path env vars (EVIDENCE_DB, WORLD_DB, TRANSCRIPT_DATA_DIR,
 * AUDIT_LOG_DIR, CLI_RAW_ARCHIVE_DIR, UPLOAD_DIR, TTS_CACHE_DIR,
 * CONNECTOR_MEDIA_DIR) are removed — configure via the three roots instead.
 */

import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
// packages/api/src/config/ → ../../uploads = packages/api/uploads
const MODULE_DEFAULT_UPLOAD_DIR = resolve(THIS_DIR, '../../uploads');

export type DataRoot = 'DATA_DIR' | 'CACHE_DIR' | 'LOG_DIR';

function readRoot(name: DataRoot): string | undefined {
  const raw = process.env[name];
  return raw && raw.trim() !== '' ? resolve(raw) : undefined;
}

function joinUnder(root: string, subPath: string): string {
  return resolve(root, subPath);
}

// --- DATA_DIR consumers --------------------------------------------------

export function resolveEvidenceDbPath(repoRoot: string): string {
  const root = readRoot('DATA_DIR');
  return root ? joinUnder(root, 'evidence.sqlite') : resolve(repoRoot, 'evidence.sqlite');
}

export function resolveWorldDbPath(repoRoot: string): string {
  const root = readRoot('DATA_DIR');
  return root ? joinUnder(root, 'world.sqlite') : resolve(repoRoot, 'world.sqlite');
}

export function resolveTranscriptsDir(monorepoRoot: string): string {
  const root = readRoot('DATA_DIR');
  return root ? joinUnder(root, 'transcripts') : resolve(monorepoRoot, 'data/transcripts');
}

export function resolveAuditLogsDir(): string {
  const root = readRoot('DATA_DIR');
  return root ? joinUnder(root, 'audit-logs') : resolve(process.cwd(), 'data/audit-logs');
}

export function resolveCliRawArchiveDir(): string {
  const root = readRoot('DATA_DIR');
  return root ? joinUnder(root, 'cli-raw-archive') : resolve(process.cwd(), 'data/cli-raw-archive');
}

export function resolveUploadsDir(): string {
  const root = readRoot('DATA_DIR');
  return root ? joinUnder(root, 'uploads') : MODULE_DEFAULT_UPLOAD_DIR;
}

// --- .cat-cafe state (writable config/data: accounts, credentials, catalog, governance…)
// When DATA_DIR is set, the shell startup moves the contents of
// {projectRoot}/.cat-cafe/ to DATA_DIR/cat-cafe/ and replaces the
// original with a symlink.  This lets all 50+ consumers keep using
// `resolve(projectRoot, '.cat-cafe', file)` transparently.

export function resolveCatCafeStateDir(projectRoot: string): string {
  const root = readRoot('DATA_DIR');
  return root ? joinUnder(root, 'cat-cafe') : resolve(projectRoot, '.cat-cafe');
}

// --- Redis data (lifecycle managed by start-dev.sh / user-redis.sh) ------
// Redis is started by shell scripts *before* the API server, so the shell
// layer owns the actual `--dir` flag and pre-start migration.  These
// resolvers exist for introspection (Settings UI / data-dirs endpoint)
// and for the shell to stay consistent with the TypeScript world.

export function resolveRedisDataDir(): string {
  const root = readRoot('DATA_DIR');
  if (root) return joinUnder(root, 'redis');
  // Legacy: shell script sets REDIS_DATA_DIR based on profile/port before
  // launching the API.  Fall back to the default dev path if not in env
  // (e.g. running `node dist/index.js` directly without start-dev.sh).
  return process.env.REDIS_DATA_DIR || resolve(homedir(), '.cat-cafe/redis-dev');
}

export function resolveRedisBackupDir(): string {
  const root = readRoot('DATA_DIR');
  if (root) return joinUnder(root, 'redis-backups');
  return process.env.REDIS_BACKUP_DIR || resolve(homedir(), '.cat-cafe/redis-backups/dev');
}

// --- CACHE_DIR consumers -------------------------------------------------

export function resolveTtsCacheDir(): string {
  const root = readRoot('CACHE_DIR');
  return root ? joinUnder(root, 'tts') : resolve(process.cwd(), 'data/tts-cache');
}

export function resolveConnectorMediaDir(): string {
  const root = readRoot('CACHE_DIR');
  return root ? joinUnder(root, 'connector-media') : resolve(process.cwd(), 'data/connector-media');
}

// --- LOG_DIR (used directly, no subdirectory) ----------------------------

export function resolveLogDir(): string {
  const root = readRoot('LOG_DIR');
  return root ?? resolve(process.cwd(), 'data/logs/api');
}

// --- Introspection (for migration logic + Settings UI) -------------------

export type DataPathKey =
  | 'evidenceDb'
  | 'worldDb'
  | 'transcripts'
  | 'auditLogs'
  | 'cliRawArchive'
  | 'uploads'
  | 'catCafeState'
  | 'redisData'
  | 'redisBackups'
  | 'ttsCache'
  | 'connectorMedia'
  | 'logs';

export interface DataPathSpec {
  /** Stable identifier */
  readonly key: DataPathKey;
  /** Which root env var governs this path */
  readonly root: DataRoot;
  /** Sub-path under the root (empty for LOG_DIR which uses the root directly) */
  readonly subPath: string;
  /** Path that would be used if the root env var is not set */
  readonly legacyPath: string;
  /** Path that would be used if the root env var IS set */
  readonly rootBasedPath: string | null;
  /** Currently active path (= rootBasedPath if root is set, else legacyPath) */
  readonly currentPath: string;
  /** Is the active path file-shaped (true for SQLite DBs) or directory-shaped */
  readonly isFile: boolean;
}

export interface DescribeOptions {
  readonly repoRoot: string;
  readonly monorepoRoot: string;
  /**
   * Override the uploads legacy path. Production code never needs this — it
   * exists so unit tests can isolate the migration engine from the real
   * `packages/api/uploads` directory inside the repo (the module-relative
   * default resolves to that exact path because the module file lives there).
   * Pass an absolute path that does NOT shadow real data.
   */
  readonly uploadsLegacyOverride?: string;
}

export function describeDataPaths(opts: DescribeOptions): readonly DataPathSpec[] {
  const dataRoot = readRoot('DATA_DIR');
  const cacheRoot = readRoot('CACHE_DIR');
  const logRoot = readRoot('LOG_DIR');
  const uploadsLegacy = opts.uploadsLegacyOverride ?? MODULE_DEFAULT_UPLOAD_DIR;

  return [
    {
      key: 'evidenceDb',
      root: 'DATA_DIR',
      subPath: 'evidence.sqlite',
      legacyPath: resolve(opts.repoRoot, 'evidence.sqlite'),
      rootBasedPath: dataRoot ? joinUnder(dataRoot, 'evidence.sqlite') : null,
      currentPath: resolveEvidenceDbPath(opts.repoRoot),
      isFile: true,
    },
    {
      key: 'worldDb',
      root: 'DATA_DIR',
      subPath: 'world.sqlite',
      legacyPath: resolve(opts.repoRoot, 'world.sqlite'),
      rootBasedPath: dataRoot ? joinUnder(dataRoot, 'world.sqlite') : null,
      currentPath: resolveWorldDbPath(opts.repoRoot),
      isFile: true,
    },
    {
      key: 'transcripts',
      root: 'DATA_DIR',
      subPath: 'transcripts',
      legacyPath: resolve(opts.monorepoRoot, 'data/transcripts'),
      rootBasedPath: dataRoot ? joinUnder(dataRoot, 'transcripts') : null,
      currentPath: resolveTranscriptsDir(opts.monorepoRoot),
      isFile: false,
    },
    {
      key: 'auditLogs',
      root: 'DATA_DIR',
      subPath: 'audit-logs',
      legacyPath: resolve(process.cwd(), 'data/audit-logs'),
      rootBasedPath: dataRoot ? joinUnder(dataRoot, 'audit-logs') : null,
      currentPath: resolveAuditLogsDir(),
      isFile: false,
    },
    {
      key: 'cliRawArchive',
      root: 'DATA_DIR',
      subPath: 'cli-raw-archive',
      legacyPath: resolve(process.cwd(), 'data/cli-raw-archive'),
      rootBasedPath: dataRoot ? joinUnder(dataRoot, 'cli-raw-archive') : null,
      currentPath: resolveCliRawArchiveDir(),
      isFile: false,
    },
    {
      key: 'uploads',
      root: 'DATA_DIR',
      subPath: 'uploads',
      legacyPath: uploadsLegacy,
      rootBasedPath: dataRoot ? joinUnder(dataRoot, 'uploads') : null,
      // Note: resolveUploadsDir() always uses MODULE_DEFAULT_UPLOAD_DIR; the
      // override only affects the legacyPath surfaced for introspection.
      currentPath: dataRoot ? joinUnder(dataRoot, 'uploads') : uploadsLegacy,
      isFile: false,
    },
    {
      key: 'catCafeState',
      root: 'DATA_DIR',
      subPath: 'cat-cafe',
      legacyPath: resolve(opts.repoRoot, '.cat-cafe'),
      rootBasedPath: dataRoot ? joinUnder(dataRoot, 'cat-cafe') : null,
      currentPath: resolveCatCafeStateDir(opts.repoRoot),
      isFile: false,
    },
    {
      key: 'redisData',
      root: 'DATA_DIR',
      subPath: 'redis',
      legacyPath: process.env.REDIS_DATA_DIR || resolve(homedir(), '.cat-cafe/redis-dev'),
      rootBasedPath: dataRoot ? joinUnder(dataRoot, 'redis') : null,
      currentPath: resolveRedisDataDir(),
      isFile: false,
    },
    {
      key: 'redisBackups',
      root: 'DATA_DIR',
      subPath: 'redis-backups',
      legacyPath: process.env.REDIS_BACKUP_DIR || resolve(homedir(), '.cat-cafe/redis-backups/dev'),
      rootBasedPath: dataRoot ? joinUnder(dataRoot, 'redis-backups') : null,
      currentPath: resolveRedisBackupDir(),
      isFile: false,
    },
    {
      key: 'ttsCache',
      root: 'CACHE_DIR',
      subPath: 'tts',
      legacyPath: resolve(process.cwd(), 'data/tts-cache'),
      rootBasedPath: cacheRoot ? joinUnder(cacheRoot, 'tts') : null,
      currentPath: resolveTtsCacheDir(),
      isFile: false,
    },
    {
      key: 'connectorMedia',
      root: 'CACHE_DIR',
      subPath: 'connector-media',
      legacyPath: resolve(process.cwd(), 'data/connector-media'),
      rootBasedPath: cacheRoot ? joinUnder(cacheRoot, 'connector-media') : null,
      currentPath: resolveConnectorMediaDir(),
      isFile: false,
    },
    {
      key: 'logs',
      root: 'LOG_DIR',
      subPath: '',
      legacyPath: resolve(process.cwd(), 'data/logs/api'),
      rootBasedPath: logRoot ?? null,
      currentPath: resolveLogDir(),
      isFile: false,
    },
  ];
}
