import { readdir, readFile } from 'node:fs/promises';
import { posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_CONFIG_PATH = resolve(
  fileURLToPath(new URL('..', import.meta.url)),
  'config/public-test-exclusions.json',
);

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isoToday() {
  return new Date().toISOString().slice(0, 10);
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
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function assertRegistryShape(registry) {
  if (!registry || typeof registry !== 'object') {
    throw new Error('public test exclusion registry must be an object');
  }
  if (registry.version !== 1) {
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

function compileEntryPattern(entry) {
  try {
    return new RegExp(entry.match);
  } catch (error) {
    throw new Error(`public test exclusion "${entry.id}" has invalid regex: ${entry.match} (${error.message})`);
  }
}

function assertEntryAgainstFilesystem(entry, pattern, allTestFiles, today) {
  if (entry.expiresOn < today) {
    throw new Error(`public test exclusion "${entry.id}" is expired (${entry.expiresOn} < ${today})`);
  }
  const hasMatch = allTestFiles.some((file) => pattern.test(file));
  if (!hasMatch) {
    throw new Error(`public test exclusion "${entry.id}" matches no current test files`);
  }
}

export function validatePublicTestExclusions(registry, options = {}) {
  assertRegistryShape(registry);

  const allTestFiles = options.allTestFiles ?? [];
  const today = options.today ?? isoToday();
  const seenIds = new Set();
  const compiledEntries = [];

  for (const entry of registry.entries) {
    assertEntryFields(entry);
    assertEntryExpiresOnFormat(entry);
    if (seenIds.has(entry.id)) {
      throw new Error(`duplicate public test exclusion id: ${entry.id}`);
    }
    seenIds.add(entry.id);
    const pattern = compileEntryPattern(entry);
    assertEntryAgainstFilesystem(entry, pattern, allTestFiles, today);
    compiledEntries.push({ ...entry, regex: pattern });
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
  const allTestFiles = await listTestFiles(resolve(packageRoot, 'test'));
  const registry = await loadPublicTestExclusions({ configPath });
  const validated = validatePublicTestExclusions(registry, {
    allTestFiles,
    today: options.today,
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

async function main() {
  const format = process.argv.includes('--json') ? 'json' : 'plain';
  const result = await resolvePublicTestFiles();
  if (format === 'json') {
    process.stdout.write(JSON.stringify(result, null, 2));
    return;
  }
  process.stdout.write(result.selectedFiles.join('\n'));
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
const modulePath = fileURLToPath(import.meta.url);

if (invokedPath === modulePath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
