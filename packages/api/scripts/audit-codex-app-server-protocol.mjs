import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SURFACE_FILES = {
  clientRequests: 'ClientRequest.json',
  serverNotifications: 'ServerNotification.json',
  serverRequests: 'ServerRequest.json',
};
const MAX_METHODS_PER_SURFACE = 2_000;
const MAX_METHOD_NAME = 240;
const MAX_THREAD_ITEM_TYPES = 500;
const MAX_THREAD_ITEM_TYPE = 160;
const MAX_SCHEMA_FINGERPRINT = 128;
const MAX_DEPRECATIONS = 200;
const MAX_DEPRECATION_PATH = 240;
const MAX_DEPRECATION_MESSAGE = 500;
function uniqueSorted(values) {
  return [...new Set(values)].sort();
}
function extractSchemaLiteral(property, label) {
  if (!property) throw new Error(`${label} schema is missing`);
  if (Array.isArray(property.enum) && typeof property.enum[0] === 'string') return property.enum[0];
  if (typeof property.const === 'string') return property.const;
  throw new Error(`${label} schema is missing a string literal`);
}
function extractMethodNames(schema) {
  if (!Array.isArray(schema?.oneOf)) throw new Error('Codex method schema does not expose oneOf');
  return uniqueSorted(
    schema.oneOf.map((variant) => extractSchemaLiteral(variant?.properties?.method, 'Codex method variant')),
  );
}
function extractThreadItemTypes(schema) {
  const variants = schema?.definitions?.ThreadItem?.oneOf;
  if (!Array.isArray(variants)) throw new Error('Codex schema does not expose definitions.ThreadItem.oneOf');
  return uniqueSorted(
    variants.map((variant) => extractSchemaLiteral(variant?.properties?.type, 'Codex ThreadItem variant')),
  );
}
function normalizeVersion(value) {
  if (typeof value !== 'string') throw new Error('Protocol audit is missing codexVersion');
  const match = value.match(/(?:codex-cli\s+)?(\d+\.\d+\.\d+)/);
  if (!match) throw new Error(`Unrecognized Codex CLI version: ${value.trim()}`);
  return match[1];
}
function normalizeLayer(layer, label) {
  if (!layer || typeof layer !== 'object' || Array.isArray(layer)) {
    throw new Error(`Protocol audit ${label} layer is missing`);
  }
  const methodSource = Object.hasOwn(layer, 'methods') ? layer.methods : layer;
  if (!methodSource || typeof methodSource !== 'object' || Array.isArray(methodSource)) {
    throw new Error(`Protocol audit ${label}.methods is missing`);
  }
  const methods = Object.fromEntries(
    Object.keys(SURFACE_FILES).map((surface) => [
      surface,
      normalizeStringList(methodSource[surface], `${label}.${surface}`, MAX_METHODS_PER_SURFACE, MAX_METHOD_NAME),
    ]),
  );
  if (
    typeof layer.schemaFingerprint !== 'string' ||
    layer.schemaFingerprint.length === 0 ||
    layer.schemaFingerprint.length > MAX_SCHEMA_FINGERPRINT
  ) {
    throw new Error(`Protocol audit ${label}.schemaFingerprint must be a bounded non-empty string`);
  }
  return {
    counts: Object.fromEntries(Object.entries(methods).map(([surface, values]) => [surface, values.length])),
    methods,
    schemaFingerprint: layer.schemaFingerprint,
    deprecations: normalizeDeprecations(layer.deprecations, `${label}.deprecations`),
  };
}

function normalizeStringList(value, label, maxEntries, maxLength) {
  if (!Array.isArray(value)) {
    throw new Error(`Protocol audit ${label} must be an array of strings`);
  }
  if (value.length > maxEntries) {
    throw new Error(`Protocol audit ${label} exceeds its bounded string-list contract`);
  }
  if (value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`Protocol audit ${label} must be an array of strings`);
  }
  if (value.some((entry) => entry.length === 0 || entry.length > maxLength)) {
    throw new Error(`Protocol audit ${label} exceeds its bounded string-list contract`);
  }
  return uniqueSorted(value);
}

function normalizeDeprecations(value, label) {
  if (!Array.isArray(value)) throw new Error(`Protocol audit ${label} must be an array`);
  if (value.length > MAX_DEPRECATIONS) {
    throw new Error(`Protocol audit ${label} exceeds ${MAX_DEPRECATIONS} entries`);
  }
  const normalized = value
    .map((entry) => {
      if (
        !entry ||
        typeof entry !== 'object' ||
        typeof entry.path !== 'string' ||
        entry.path.length === 0 ||
        entry.path.length > MAX_DEPRECATION_PATH ||
        typeof entry.message !== 'string' ||
        entry.message.length === 0 ||
        entry.message.length > MAX_DEPRECATION_MESSAGE
      ) {
        throw new Error(`Protocol audit ${label} entries require bounded path and message strings`);
      }
      return { path: entry.path, message: entry.message };
    })
    .sort((a, b) => a.path.localeCompare(b.path) || a.message.localeCompare(b.message));
  return [...new Map(normalized.map((entry) => [JSON.stringify(entry), entry])).values()];
}

function boundCollectedDeprecations(value) {
  const normalized = value
    .filter(
      (entry) =>
        entry && typeof entry === 'object' && typeof entry.path === 'string' && typeof entry.message === 'string',
    )
    .map((entry) => ({
      path: entry.path.slice(0, MAX_DEPRECATION_PATH),
      message: entry.message.slice(0, MAX_DEPRECATION_MESSAGE),
    }))
    .filter((entry) => entry.path.length > 0 && entry.message.length > 0)
    .sort((a, b) => a.path.localeCompare(b.path) || a.message.localeCompare(b.message));
  return [...new Map(normalized.map((entry) => [JSON.stringify(entry), entry])).values()].slice(0, MAX_DEPRECATIONS);
}

function computeMethodDelta(stable, experimental) {
  return Object.fromEntries(
    Object.keys(SURFACE_FILES).map((surface) => [
      surface,
      experimental.methods[surface].filter((method) => !stable.methods[surface].includes(method)),
    ]),
  );
}

export function computeProtocolSnapshot(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('Protocol audit snapshot must be an object');
  }
  const codexVersion = normalizeVersion(source?.codexVersion);
  const stable = normalizeLayer(source.stable, 'stable');
  const experimental = normalizeLayer(source.experimental, 'experimental');
  return {
    codexVersion,
    stable,
    experimental: {
      ...experimental,
      methodDelta: computeMethodDelta(stable, experimental),
    },
    threadItemTypes: normalizeStringList(
      source.threadItemTypes,
      'threadItemTypes',
      MAX_THREAD_ITEM_TYPES,
      MAX_THREAD_ITEM_TYPE,
    ),
  };
}

function compareStringLists(previous, current) {
  const before = uniqueSorted(previous ?? []);
  const after = uniqueSorted(current ?? []);
  return {
    added: after.filter((value) => !before.includes(value)),
    removed: before.filter((value) => !after.includes(value)),
  };
}

function compareDeprecations(previous, current) {
  const key = (value) => JSON.stringify([value.path, value.message]);
  const before = normalizeDeprecations(previous, 'previous.deprecations');
  const after = normalizeDeprecations(current, 'current.deprecations');
  const beforeKeys = new Set(before.map(key));
  const afterKeys = new Set(after.map(key));
  return {
    added: after.filter((value) => !beforeKeys.has(key(value))),
    removed: before.filter((value) => !afterKeys.has(key(value))),
  };
}

function compareLayer(previous, current) {
  const before = normalizeLayer(previous, 'previous');
  const after = normalizeLayer(current, 'current');
  return {
    schemaChanged: before.schemaFingerprint !== after.schemaFingerprint,
    fromSchemaFingerprint: before.schemaFingerprint,
    toSchemaFingerprint: after.schemaFingerprint,
    methods: Object.fromEntries(
      Object.keys(SURFACE_FILES).map((surface) => [
        surface,
        compareStringLists(before.methods[surface], after.methods[surface]),
      ]),
    ),
    deprecations: compareDeprecations(before.deprecations, after.deprecations),
  };
}

export function compareProtocolSnapshots(previousSource, currentSource) {
  const previous = computeProtocolSnapshot(previousSource);
  const current = computeProtocolSnapshot(currentSource);
  return {
    fromVersion: previous.codexVersion,
    toVersion: current.codexVersion,
    stable: compareLayer(previous.stable, current.stable),
    experimental: compareLayer(previous.experimental, current.experimental),
    threadItemTypes: compareStringLists(previous.threadItemTypes, current.threadItemTypes),
  };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readMethodLayer(dir) {
  return {
    ...Object.fromEntries(
      Object.entries(SURFACE_FILES).map(([surface, fileName]) => [
        surface,
        extractMethodNames(readJson(join(dir, fileName))),
      ]),
    ),
    ...readLayerMetadata(dir),
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function collectJsonPaths(dir, prefix = '') {
  const paths = [];
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const relativePath = join(prefix, entry.name);
    if (entry.isDirectory()) paths.push(...collectJsonPaths(dir, relativePath));
    else if (entry.isFile() && entry.name.endsWith('.json')) paths.push(relativePath);
  }
  return paths.sort();
}

function collectDeprecations(value, schemaPath, jsonPath = '$', output = []) {
  if (output.length >= 200 || !value || typeof value !== 'object') return output;
  if (value.deprecated === true) {
    output.push({
      path: semanticSchemaPath(schemaPath, jsonPath),
      message:
        typeof value.description === 'string' && value.description.length > 0
          ? value.description
          : 'Schema entry is marked deprecated',
    });
  } else if (
    typeof value.description === 'string' &&
    /^\s*(?:@deprecated\b|deprecated[:\s])/i.test(value.description)
  ) {
    output.push({ path: semanticSchemaPath(schemaPath, jsonPath), message: value.description });
  }
  for (const [key, nested] of Object.entries(value)) {
    collectDeprecations(nested, schemaPath, `${jsonPath}.${key}`, output);
    if (output.length >= 200) break;
  }
  return output;
}

function semanticSchemaPath(schemaPath, jsonPath) {
  return `${schemaPath}:${jsonPath.replace(/\.(oneOf|anyOf|allOf)\.\d+/g, '.$1[]')}`;
}

function readLayerMetadata(dir) {
  const schemaFiles = collectJsonPaths(dir);
  const parsed = schemaFiles.map((path) => ({ path, value: readJson(join(dir, path)) }));
  const schemaFingerprint = createHash('sha256')
    .update(parsed.map(({ path, value }) => `${path}\n${canonicalJson(value)}\n`).join(''))
    .digest('hex');
  const deprecationSources = parsed.filter(({ path }) => path.endsWith('.v2.schemas.json'));
  return {
    schemaFingerprint,
    deprecations: boundCollectedDeprecations(
      (deprecationSources.length > 0 ? deprecationSources : parsed).flatMap(({ path, value }) =>
        collectDeprecations(value, path),
      ),
    ),
  };
}

export function collectInstalledProtocolSnapshot() {
  const generatedDir = mkdtempSync(join(tmpdir(), 'cat-cafe-codex-protocol-audit-'));
  const stableDir = join(generatedDir, 'stable');
  const experimentalDir = join(generatedDir, 'experimental');
  mkdirSync(stableDir);
  mkdirSync(experimentalDir);
  try {
    const codexVersion = execFileSync('codex', ['--version'], { encoding: 'utf8', stdio: 'pipe' });
    execFileSync('codex', ['app-server', 'generate-json-schema', '--out', stableDir], { stdio: 'pipe' });
    execFileSync('codex', ['app-server', 'generate-json-schema', '--experimental', '--out', experimentalDir], {
      stdio: 'pipe',
    });
    return collectProtocolSnapshotFromDirectories({
      codexVersion,
      stableDir,
      experimentalDir,
    });
  } finally {
    rmSync(generatedDir, { recursive: true, force: true });
  }
}

export function collectProtocolSnapshotFromDirectories({ codexVersion, stableDir, experimentalDir }) {
  const schemaName = readdirSync(experimentalDir).find((name) => name.endsWith('.v2.schemas.json'));
  if (!schemaName) throw new Error('Codex schema generator did not write a .v2.schemas.json file');
  return computeProtocolSnapshot({
    codexVersion,
    stable: readMethodLayer(stableDir),
    experimental: readMethodLayer(experimentalDir),
    threadItemTypes: extractThreadItemTypes(readJson(join(experimentalDir, schemaName))),
  });
}

export function runProtocolAudit(argv = process.argv.slice(2)) {
  const againstIndex = argv.indexOf('--against');
  let previous;
  if (againstIndex >= 0) {
    const compactPrevious = argv[againstIndex + 1];
    if (!compactPrevious) throw new Error('--against requires a compact JSON protocol snapshot');
    previous = computeProtocolSnapshot(JSON.parse(compactPrevious));
  }
  const current = collectInstalledProtocolSnapshot();
  if (againstIndex < 0) {
    process.stdout.write(`${JSON.stringify(current, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    `${JSON.stringify({ snapshot: current, delta: compareProtocolSnapshots(previous, current) }, null, 2)}\n`,
  );
}

const directRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (directRun) runProtocolAudit();
