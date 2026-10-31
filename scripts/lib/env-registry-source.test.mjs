import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { it } from 'node:test';
import { parseCategories, parseVars } from './env-registry-parser.mjs';
import { loadEnvRegistrySource } from './env-registry-source.mjs';

function fixture(t, files) {
  const root = mkdtempSync(join(tmpdir(), 'env-registry-source-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [name, source] of Object.entries(files)) writeFileSync(join(root, name), source);
  return join(root, 'registry.ts');
}

it('expands only referenced arrays, in order, without executing application imports', (t) => {
  const path = fixture(t, {
    'registry.ts': `
      import { DEFINITIONS as PART } from './part.js';
      import './must-not-execute.js';
      export const ENV_CATEGORIES = { server: 'Server', cli: 'CLI' };
      const ORPHAN = [{ name: 'UNREGISTERED', exampleRecommended: true }];
      export const ENV_VARS = [...PART, { name: 'LAST', category: 'cli', defaultValue: '0' }];
    `,
    'part.ts': `
      import type { EnvDefinition } from './registry.js';
      import { NOT_READ } from 'must-not-resolve-or-execute';
      throw new Error('application code must never run');
      const LOCAL = [{ name: 'FIRST', category: 'server', description: 'one ' + 'two',
        defaultValue: 'a}b', sensitive: true, exampleRecommended: true }];
      export const DEFINITIONS: readonly EnvDefinition[] = [...LOCAL];
      export const UNUSED = [{ name: 'ALSO_UNREGISTERED' }];
    `,
    'unreferenced.ts': "export const UNUSED = [{ name: 'NOT_REGISTERED' }];",
  });
  const source = loadEnvRegistrySource(path);
  assert.deepEqual(
    [...parseCategories(source)],
    [
      ['server', 'Server'],
      ['cli', 'CLI'],
    ],
  );
  const vars = parseVars(source);
  assert.deepEqual(
    vars.map(({ name }) => name),
    ['FIRST', 'LAST'],
  );
  assert.deepEqual(vars[0], {
    name: 'FIRST',
    category: 'server',
    description: 'one two',
    defaultValue: 'a}b',
    sensitive: true,
    exampleRecommended: true,
  });
  // The completeness and example gates must still reject missing entries.
  const registered = new Set(vars.map(({ name }) => name));
  assert.deepEqual(
    ['FIRST', 'UNREGISTERED'].filter((name) => !registered.has(name)),
    ['UNREGISTERED'],
  );
  assert.deepEqual(
    vars.filter((v) => v.exampleRecommended).map((v) => v.name),
    ['FIRST'],
  );
});

it('fails on unresolved and computed spreads instead of silently losing definitions', (t) => {
  for (const expression of ['...MISSING', '...buildDefinitions()', '...external.PART']) {
    const path = fixture(t, { 'registry.ts': `export const ENV_VARS = [${expression}];` });
    assert.throws(() => loadEnvRegistrySource(path), /Unsupported|Expected static/);
  }
});

it('fails on cyclic local/imported arrays', (t) => {
  const path = fixture(t, {
    'registry.ts': "import { PART } from './part.js'; export const ENV_VARS = [...PART];",
    'part.ts': "import { ENV_VARS } from './registry.js'; export const PART = [...ENV_VARS];",
  });
  assert.throws(() => loadEnvRegistrySource(path), /Cyclic registry array/);
});

it('rejects array imports outside the registry directory and missing source modules', (t) => {
  const outside = fixture(t, { 'registry.ts': 'export const ENV_VARS = [];' });
  const path = fixture(t, {
    'registry.ts': `import { ENV_VARS as PART } from ${JSON.stringify(outside.replaceAll('\\', '/'))};
      export const ENV_VARS = [...PART];`,
  });
  assert.throws(() => loadEnvRegistrySource(path), /Unsupported registry array reference/);
  writeFileSync(
    path,
    `import { ENV_VARS as PART } from ${JSON.stringify(relative(dirname(path), outside).replaceAll('\\', '/'))};
    export const ENV_VARS = [...PART];`,
  );
  assert.throws(() => loadEnvRegistrySource(path), /escapes its directory/);
  const missing = fixture(t, {
    'registry.ts': "import { PART } from './missing.js'; export const ENV_VARS = [...PART];",
  });
  assert.throws(() => loadEnvRegistrySource(missing), /ENOENT/);
});
