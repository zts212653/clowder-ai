import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_CONFIG_PATH = resolve(
  fileURLToPath(new URL('..', import.meta.url)),
  'config/public-test-exclusions.json',
);
export const DEFAULT_POLICY_TIMEZONE = 'America/Los_Angeles';

export function stablePublicTestSha256(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function publicTestSelectionHash(selectedFiles) {
  return stablePublicTestSha256({ selectedFiles: [...selectedFiles].sort() });
}

export function publicTestExclusionMatchHash(matchedFiles) {
  return stablePublicTestSha256({ matchedFiles: [...matchedFiles].sort() });
}

export function publicTestExclusionRegistryHash(registry) {
  return stablePublicTestSha256({ version: registry.version, entries: registry.entries });
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

export function formatLocalIsoDate(
  date = new Date(),
  timeZone = process.env.CAT_CAFE_POLICY_TIMEZONE ?? DEFAULT_POLICY_TIMEZONE,
) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    ...(timeZone ? { timeZone } : {}),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function isoToday() {
  return formatLocalIsoDate();
}

async function listTestFiles(rootDir, relDir = '') {
  const dir = resolve(rootDir, relDir);
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const relPath = relDir ? posix.join(relDir, entry.name) : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await listTestFiles(rootDir, relPath)));
      continue;
    }
    if (entry.isFile() && relPath.endsWith('.test.js')) {
      files.push(posix.join('test', relPath));
    }
  }

  return files.sort();
}

export async function loadPublicTestExclusions(options = {}) {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
  const raw = await readFile(configPath, 'utf8');
  return JSON.parse(raw);
}

const REQUIRED_ENTRY_FIELDS = ['id', 'match', 'category', 'reason', 'owner', 'introducedBy', 'expiresOn'];
const REQUIRED_AUDIT_FIELDS = [
  'reviewedOn',
  'sourceHead',
  'publicHead',
  'status',
  'matchedFileCount',
  'matchedFilesHash',
];
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const AUDIT_STATUSES = new Set([
  'resource_contract',
  'source_dependency_failure',
  'private_fixture_failure',
  'pending_bounded_recheck',
]);

function assertRegistryShape(registry) {
  if (!registry || typeof registry !== 'object') {
    throw new Error('public test exclusion registry must be an object');
  }
  if (registry.version !== 2) {
    throw new Error(`unsupported public test exclusion registry version: ${registry.version}`);
  }
  if (!Array.isArray(registry.entries)) {
    throw new Error('public test exclusion registry entries must be an array');
  }
}

function assertEntryFields(entry) {
  if (!entry || typeof entry !== 'object') {
    throw new Error('public test exclusion entry must be an object');
  }
  for (const field of REQUIRED_ENTRY_FIELDS) {
    if (!isNonEmptyString(entry[field])) {
      throw new Error(`public test exclusion "${entry.id ?? '<missing-id>'}" is missing required field: ${field}`);
    }
  }
}

function assertEntryExpiresOnFormat(entry) {
  // Strict YYYY-MM-DD only — lexicographic compare in assertEntryAgainstFilesystem
  // is correct iff the format is fixed. Reject `2026-6-23`, `never`, `2026/06/23`
  // up front so a typo can never silently keep an exclusion active past TTL
  // (codex review #2326 P2, 2026-06-16).
  if (!ISO_DATE_PATTERN.test(entry.expiresOn)) {
    throw new Error(
      `public test exclusion "${entry.id}" expiresOn must be in YYYY-MM-DD format, got: ${entry.expiresOn}`,
    );
  }
  // Reject syntactically-valid but semantically-invalid calendar dates like
  // 2026-13-99 — Date() will roll them over and lexicographic compare would
  // accept the rolled value.
  const parsed = new Date(`${entry.expiresOn}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== entry.expiresOn) {
    throw new Error(`public test exclusion "${entry.id}" expiresOn is not a valid calendar date: ${entry.expiresOn}`);
  }
}

function assertAuditDate(audit, entry, field) {
  if (!ISO_DATE_PATTERN.test(audit.reviewedOn)) {
    throw new Error(
      `public test exclusion "${entry.id}" ${field}.reviewedOn must be in YYYY-MM-DD format, got: ${audit.reviewedOn}`,
    );
  }
  const parsed = new Date(`${audit.reviewedOn}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== audit.reviewedOn) {
    throw new Error(`public test exclusion "${entry.id}" ${field}.reviewedOn is not a valid calendar date`);
  }
}

function assertAuditRecord(entry, audit, field) {
  if (!audit || typeof audit !== 'object' || Array.isArray(audit)) {
    throw new Error(`public test exclusion "${entry.id}" is missing required ${field} object`);
  }
  for (const auditField of REQUIRED_AUDIT_FIELDS) {
    if (audit[auditField] === undefined || audit[auditField] === null || audit[auditField] === '') {
      throw new Error(`public test exclusion "${entry.id}" ${field} is missing required field: ${auditField}`);
    }
  }
  assertAuditDate(audit, entry, field);
  if (!SHA_PATTERN.test(audit.sourceHead) || !SHA_PATTERN.test(audit.publicHead)) {
    throw new Error(
      `public test exclusion "${entry.id}" ${field} sourceHead/publicHead must be full 40-character SHAs`,
    );
  }
  if (!AUDIT_STATUSES.has(audit.status)) {
    throw new Error(`public test exclusion "${entry.id}" ${field} status is invalid: ${audit.status}`);
  }
  if (!Number.isSafeInteger(audit.matchedFileCount) || audit.matchedFileCount <= 0) {
    throw new Error(`public test exclusion "${entry.id}" ${field} matchedFileCount must be a positive integer`);
  }
  if (!SHA256_PATTERN.test(audit.matchedFilesHash)) {
    throw new Error(`public test exclusion "${entry.id}" ${field} matchedFilesHash must be a SHA-256 hex digest`);
  }
}

function assertEntryAudit(entry) {
  assertAuditRecord(entry, entry.audit, 'audit');
  if (entry.publicAudit !== undefined) {
    assertAuditRecord(entry, entry.publicAudit, 'publicAudit');
  }
}

function compileEntryPattern(entry) {
  try {
    return new RegExp(entry.match);
  } catch (error) {
    throw new Error(`public test exclusion "${entry.id}" has invalid regex: ${entry.match} (${error.message})`);
  }
}

function assertEntryAgainstFilesystem(entry, pattern, allTestFiles, today, auditProfile) {
  if (entry.expiresOn < today) {
    throw new Error(`public test exclusion "${entry.id}" is expired (${entry.expiresOn} < ${today})`);
  }
  const matchedFiles = allTestFiles.filter((file) => pattern.test(file)).sort();
  if (matchedFiles.length === 0) {
    throw new Error(`public test exclusion "${entry.id}" matches no current test files`);
  }
  const audit = auditProfile === 'public' ? (entry.publicAudit ?? entry.audit) : entry.audit;
  const actualHash = publicTestExclusionMatchHash(matchedFiles);
  if (audit.matchedFileCount !== matchedFiles.length || audit.matchedFilesHash !== actualHash) {
    throw new Error(
      `public test exclusion "${entry.id}" audited match inventory drift (expected ${audit.matchedFileCount}/${audit.matchedFilesHash}, got ${matchedFiles.length}/${actualHash})`,
    );
  }
  return matchedFiles;
}

export function validatePublicTestExclusions(registry, options = {}) {
  assertRegistryShape(registry);

  const allTestFiles = options.allTestFiles ?? [];
  const today = options.today ?? isoToday();
  const auditProfile = options.auditProfile ?? 'source';
  if (auditProfile !== 'source' && auditProfile !== 'public') {
    throw new Error(`unsupported public test exclusion audit profile: ${auditProfile}`);
  }
  const seenIds = new Set();
  const compiledEntries = [];

  for (const entry of registry.entries) {
    assertEntryFields(entry);
    assertEntryExpiresOnFormat(entry);
    assertEntryAudit(entry);
    if (seenIds.has(entry.id)) {
      throw new Error(`duplicate public test exclusion id: ${entry.id}`);
    }
    seenIds.add(entry.id);
    const pattern = compileEntryPattern(entry);
    const matchedFiles = assertEntryAgainstFilesystem(entry, pattern, allTestFiles, today, auditProfile);
    compiledEntries.push({ ...entry, regex: pattern, matchedFiles });
  }

  // Backward-compatible default return is the registry; compiled patterns are
  // exposed via a non-enumerable property so callers that want to skip a
  // second compilation pass can read them, while existing callers that ignore
  // the return value (the validator unit tests) keep working unchanged.
  Object.defineProperty(registry, 'compiledEntries', {
    value: compiledEntries,
    enumerable: false,
    configurable: true,
  });
  return registry;
}

export async function resolvePublicTestFiles(options = {}) {
  const packageRoot = options.packageRoot ?? fileURLToPath(new URL('..', import.meta.url));
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
  const repoRoot = resolve(packageRoot, '..', '..');
  const auditProfile =
    options.auditProfile ?? (existsSync(resolve(repoRoot, '.sync-provenance.json')) ? 'public' : 'source');
  const allTestFiles = await listTestFiles(resolve(packageRoot, 'test'));
  const registry = await loadPublicTestExclusions({ configPath });
  const validated = validatePublicTestExclusions(registry, {
    allTestFiles,
    today: options.today,
    auditProfile,
  });
  const compiledEntries = validated.compiledEntries;

  const selectedFiles = allTestFiles.filter((file) => compiledEntries.every((entry) => !entry.regex.test(file))).sort();
  const excludedFiles = allTestFiles.filter((file) => compiledEntries.some((entry) => entry.regex.test(file))).sort();

  return {
    registry,
    selectedFiles,
    excludedFiles,
  };
}

export function selectFocusedPublicTestFiles(result, rawFocus = '') {
  if (!isNonEmptyString(rawFocus)) return result.selectedFiles;

  const requested = rawFocus
    .split(',')
    .map((file) => file.trim())
    .filter(Boolean);
  if (requested.length === 0) {
    throw new Error('CAT_CAFE_PUBLIC_TEST_FOCUS must name at least one comma-separated test file');
  }
  if (new Set(requested).size !== requested.length) {
    throw new Error('CAT_CAFE_PUBLIC_TEST_FOCUS contains duplicate test files');
  }

  const selected = new Set(result.selectedFiles);
  const excluded = new Set(result.excludedFiles);
  for (const file of requested) {
    if (excluded.has(file)) {
      throw new Error(`focused public test is excluded by registry: ${file}`);
    }
    if (!selected.has(file)) {
      throw new Error(`focused public test does not exist in the selected public suite: ${file}`);
    }
  }
  return requested;
}

export function buildPublicTestManifest(result, selectedFiles = result.selectedFiles) {
  const selected = [...selectedFiles].sort();
  const excluded = [...result.excludedFiles].sort();
  return {
    schemaVersion: 1,
    selectedFiles: selected,
    excludedFiles: excluded,
    selectionHash: publicTestSelectionHash(selected),
    exclusionRegistryHash: publicTestExclusionRegistryHash(result.registry),
  };
}

async function main() {
  const format = process.argv.includes('--json') ? 'json' : 'plain';
  const result = await resolvePublicTestFiles();
  const selectedFiles = selectFocusedPublicTestFiles(result, process.env.CAT_CAFE_PUBLIC_TEST_FOCUS);
  if (format === 'json') {
    process.stdout.write(JSON.stringify({ ...result, ...buildPublicTestManifest(result, selectedFiles) }, null, 2));
    return;
  }
  process.stdout.write(selectedFiles.join('\n'));
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
const modulePath = fileURLToPath(import.meta.url);

if (invokedPath === modulePath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
