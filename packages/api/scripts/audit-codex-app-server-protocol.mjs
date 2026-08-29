import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SURFACE_FILES = {
  clientRequests: 'ClientRequest.json',
  serverNotifications: 'ServerNotification.json',
  serverRequests: 'ServerRequest.json',
};

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

function normalizeLayer(layer) {
  const methods = Object.fromEntries(
    Object.keys(SURFACE_FILES).map((surface) => [surface, uniqueSorted(layer?.[surface] ?? [])]),
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
  if (!Array.isArray(source?.threadItemTypes)) throw new Error('Protocol audit is missing threadItemTypes');
  const stable = normalizeLayer(source.stable);
  const experimental = normalizeLayer(source.experimental);
  return {
    codexVersion: normalizeVersion(source.codexVersion),
    stable,
    experimental: {
      ...experimental,
      methodDelta: computeMethodDelta(stable, experimental),
    },
    threadItemTypes: uniqueSorted(source.threadItemTypes),
  };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readMethodLayer(dir) {
  return Object.fromEntries(
    Object.entries(SURFACE_FILES).map(([surface, fileName]) => [
      surface,
      extractMethodNames(readJson(join(dir, fileName))),
    ]),
  );
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
    const schemaName = readdirSync(experimentalDir).find((name) => name.endsWith('.v2.schemas.json'));
    if (!schemaName) throw new Error('Codex schema generator did not write a .v2.schemas.json file');
    return computeProtocolSnapshot({
      codexVersion,
      stable: readMethodLayer(stableDir),
      experimental: readMethodLayer(experimentalDir),
      threadItemTypes: extractThreadItemTypes(readJson(join(experimentalDir, schemaName))),
    });
  } finally {
    rmSync(generatedDir, { recursive: true, force: true });
  }
}

export function runProtocolAudit() {
  process.stdout.write(`${JSON.stringify(collectInstalledProtocolSnapshot(), null, 2)}\n`);
}

const directRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (directRun) runProtocolAudit();
