import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertCodexThreadItemCensus } from '../dist/domains/cats/services/agents/providers/codex-app-server-boundary.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, '../test/fixtures/codex-app-server-thread-item-types.json');
const SURFACE_FILES = {
  clientRequests: 'ClientRequest.json',
  serverNotifications: 'ServerNotification.json',
  serverRequests: 'ServerRequest.json',
};
const STABLE_DISPOSITIONS = new Set(['native', 'adapted', 'delegated', 'deferred', 'unsupported_by_policy']);

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

function extractSchemaLiteral(property, label) {
  if (!property) throw new Error(`${label} schema is missing`);
  if (Array.isArray(property.enum)) {
    const literal = property.enum[0];
    if (typeof literal === 'string') return literal;
  }
  if (typeof property.const === 'string') return property.const;
  throw new Error(`${label} schema is missing a string literal`);
}

function extractMethodNames(schema) {
  const variants = schema?.oneOf;
  if (!Array.isArray(variants)) throw new Error('Codex method schema does not expose oneOf');
  return uniqueSorted(
    variants.map((variant) => extractSchemaLiteral(variant?.properties?.method, 'Codex method variant')),
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
  if (typeof value !== 'string') throw new Error('Protocol census is missing codexVersion');
  const match = value.match(/(?:codex-cli\s+)?(\d+\.\d+\.\d+)/);
  if (!match) throw new Error(`Unrecognized Codex CLI version: ${value.trim()}`);
  return match[1];
}

function normalizeMethodEntries(values) {
  if (!Array.isArray(values)) return [];
  return uniqueSorted(
    values.map((value) => {
      if (typeof value === 'string') return value;
      if (value && typeof value === 'object' && typeof value.method === 'string') return value.method;
      throw new Error('Protocol census method entry is missing method');
    }),
  );
}

function normalizeLayer(layer) {
  const methods = Object.fromEntries(
    Object.keys(SURFACE_FILES).map((surface) => [surface, normalizeMethodEntries(layer?.methods?.[surface])]),
  );
  return {
    counts: Object.fromEntries(Object.entries(methods).map(([surface, values]) => [surface, values.length])),
    methods,
  };
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
  if (!Array.isArray(source?.threadItemTypes)) {
    throw new Error('Protocol census is missing threadItemTypes');
  }
  const stable = normalizeLayer(source?.stable);
  const experimental = normalizeLayer(source?.experimental);
  return {
    codexVersion: normalizeVersion(source?.codexVersion),
    stable,
    experimental: {
      ...experimental,
      methodDelta: computeMethodDelta(stable, experimental),
    },
    threadItemTypes: uniqueSorted(source.threadItemTypes),
  };
}

function assertDeclaredCounts(label, layer) {
  for (const surface of Object.keys(SURFACE_FILES)) {
    const declared = layer?.counts?.[surface];
    const methods = normalizeMethodEntries(layer?.methods?.[surface]);
    if (declared !== methods.length) {
      throw new Error(`${label}.${surface} count mismatch: declared=${String(declared)}, methods=${methods.length}`);
    }
  }
}

function assertNonEmptyMetadata(surface, entry, field) {
  if (typeof entry[field] !== 'string') {
    throw new Error(`stable.${surface}.${entry.method} is missing ${field}`);
  }
  if (entry[field].trim().length === 0) {
    throw new Error(`stable.${surface}.${entry.method} is missing ${field}`);
  }
}

function assertDispositionEntry(surface, entry, seen) {
  if (!entry) throw new Error(`stable.${surface} contains a malformed disposition entry`);
  if (typeof entry !== 'object') {
    throw new Error(`stable.${surface} contains a malformed disposition entry`);
  }
  if (typeof entry.method !== 'string') {
    throw new Error(`stable.${surface} contains a malformed disposition entry`);
  }
  if (seen.has(entry.method)) throw new Error(`stable.${surface} duplicates method ${entry.method}`);
  seen.add(entry.method);
  if (!STABLE_DISPOSITIONS.has(entry.disposition)) {
    throw new Error(`stable.${surface}.${entry.method} has invalid disposition ${String(entry.disposition)}`);
  }
  for (const field of ['owner', 'maturity', 'validationRef']) {
    assertNonEmptyMetadata(surface, entry, field);
  }
}

function assertStableDispositionMatrix(fixture) {
  for (const surface of Object.keys(SURFACE_FILES)) {
    const entries = fixture?.stable?.methods?.[surface];
    if (!Array.isArray(entries)) throw new Error(`stable.${surface} disposition matrix is missing`);
    const seen = new Set();
    for (const entry of entries) {
      assertDispositionEntry(surface, entry, seen);
    }
  }
}

function assertExactSet(label, expectedValues, actualValues) {
  const expected = uniqueSorted(expectedValues);
  const actual = uniqueSorted(actualValues);
  const missing = expected.filter((value) => !actual.includes(value));
  const unknown = actual.filter((value) => !expected.includes(value));
  if (missing.length + unknown.length > 0) {
    throw new Error(`${label} drift: missing=[${missing.join(',')}], unknown=[${unknown.join(',')}]`);
  }
}

export function assertProtocolCensus(expectedFixture, actualSource) {
  assertDeclaredCounts('stable', expectedFixture?.stable);
  assertDeclaredCounts('experimental', expectedFixture?.experimental);
  assertStableDispositionMatrix(expectedFixture);

  const expected = computeProtocolSnapshot(expectedFixture);
  const actual = computeProtocolSnapshot(actualSource);
  if (expected.codexVersion !== actual.codexVersion) {
    throw new Error(`Codex CLI version drift: expected=${expected.codexVersion}, actual=${actual.codexVersion}`);
  }

  for (const surface of Object.keys(SURFACE_FILES)) {
    assertExactSet(`stable.${surface}`, expected.stable.methods[surface], actual.stable.methods[surface]);
    assertExactSet(
      `experimental.${surface}`,
      expected.experimental.methods[surface],
      actual.experimental.methods[surface],
    );
    assertExactSet(
      `experimentalDelta.${surface}`,
      expected.experimental.methodDelta[surface],
      expectedFixture.experimental.methodDelta[surface],
    );
    assertExactSet(
      `installedExperimentalDelta.${surface}`,
      expected.experimental.methodDelta[surface],
      actual.experimental.methodDelta[surface],
    );
  }

  assertExactSet('ThreadItem', expected.threadItemTypes, actual.threadItemTypes);
  assertCodexThreadItemCensus(actual.threadItemTypes);
  return actual;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readMethodLayer(dir) {
  return {
    methods: Object.fromEntries(
      Object.entries(SURFACE_FILES).map(([surface, fileName]) => [
        surface,
        extractMethodNames(readJson(join(dir, fileName))),
      ]),
    ),
  };
}

function loadInstalledCensus() {
  const generatedDir = mkdtempSync(join(tmpdir(), 'cat-cafe-codex-protocol-census-'));
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
    const schemaName = readdirSync(experimentalDir).find((name) => name.endsWith('.v2.schemas.json'));
    if (!schemaName) throw new Error('Codex schema generator did not write a .v2.schemas.json file');
    return {
      source: 'installed',
      snapshot: computeProtocolSnapshot({
        codexVersion,
        stable: readMethodLayer(stableDir),
        experimental: readMethodLayer(experimentalDir),
        threadItemTypes: extractThreadItemTypes(readJson(join(experimentalDir, schemaName))),
      }),
    };
  } finally {
    rmSync(generatedDir, { recursive: true, force: true });
  }
}

function loadPinnedCensus() {
  const fixture = readJson(fixturePath);
  return {
    source: `pinned:${normalizeVersion(fixture.codexVersion)}`,
    fixture,
    snapshot: computeProtocolSnapshot(fixture),
  };
}

export function runProtocolCensus() {
  const pinned = loadPinnedCensus();
  let census;
  try {
    census = loadInstalledCensus();
  } catch (error) {
    const unavailable = error && typeof error === 'object' && error.code === 'ENOENT';
    if (!unavailable) throw error;
    if (process.env.CAT_CAFE_REQUIRE_INSTALLED_CODEX_CENSUS === '1') throw error;
    census = { source: pinned.source, snapshot: pinned.snapshot };
  }
  const snapshot = assertProtocolCensus(pinned.fixture, census.snapshot);
  const stable = snapshot.stable.counts;
  const experimental = snapshot.experimental.counts;
  const delta = snapshot.experimental.methodDelta;
  process.stdout.write(
    `Codex app-server protocol census OK (${census.source}, version=${snapshot.codexVersion}, ` +
      `stable=${stable.clientRequests}/${stable.serverNotifications}/${stable.serverRequests}, ` +
      `experimental=${experimental.clientRequests}/${experimental.serverNotifications}/${experimental.serverRequests}, ` +
      `delta=${delta.clientRequests.length}/${delta.serverNotifications.length}/${delta.serverRequests.length}, ` +
      `ThreadItem=${snapshot.threadItemTypes.length})\n`,
  );
}

const directRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (directRun) runProtocolCensus();
