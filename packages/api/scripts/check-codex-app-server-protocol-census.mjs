import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertCodexThreadItemCensus } from '../dist/domains/cats/services/agents/providers/codex-app-server-boundary.js';

const here = dirname(fileURLToPath(import.meta.url));

function extractThreadItemTypes(schema) {
  const variants = schema?.definitions?.ThreadItem?.oneOf;
  if (!Array.isArray(variants)) throw new Error('Codex schema does not expose definitions.ThreadItem.oneOf');
  return variants.map((variant) => {
    const typeSchema = variant?.properties?.type;
    const itemType = typeSchema?.enum?.[0] ?? typeSchema?.const;
    if (typeof itemType !== 'string') throw new Error('Codex ThreadItem variant is missing a literal type');
    return itemType;
  });
}

function loadInstalledCensus() {
  const generatedDir = mkdtempSync(join(tmpdir(), 'cat-cafe-codex-protocol-census-'));
  try {
    execFileSync('codex', ['app-server', 'generate-json-schema', '--experimental', '--out', generatedDir], {
      stdio: 'pipe',
    });
    const schemaName = readdirSync(generatedDir).find((name) => name.endsWith('.v2.schemas.json'));
    if (!schemaName) throw new Error('Codex schema generator did not write a .schemas.json file');
    return {
      source: 'installed',
      itemTypes: extractThreadItemTypes(JSON.parse(readFileSync(join(generatedDir, schemaName), 'utf8'))),
    };
  } finally {
    rmSync(generatedDir, { recursive: true, force: true });
  }
}

function loadPinnedCensus() {
  const fixture = JSON.parse(
    readFileSync(join(here, '../test/fixtures/codex-app-server-thread-item-types.json'), 'utf8'),
  );
  if (!Array.isArray(fixture.threadItemTypes)) throw new Error('Pinned Codex ThreadItem census is malformed');
  return { source: `pinned:${fixture.codexVersion ?? 'unknown'}`, itemTypes: fixture.threadItemTypes };
}

let census;
try {
  census = loadInstalledCensus();
} catch (error) {
  const unavailable = error && typeof error === 'object' && error.code === 'ENOENT';
  if (!unavailable || process.env.CAT_CAFE_REQUIRE_INSTALLED_CODEX_CENSUS === '1') throw error;
  census = loadPinnedCensus();
}
assertCodexThreadItemCensus(census.itemTypes);
process.stdout.write(`Codex app-server ThreadItem census OK (${census.source}, ${census.itemTypes.length} variants)\n`);
