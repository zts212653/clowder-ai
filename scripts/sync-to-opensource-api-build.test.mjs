import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const root = resolve(import.meta.dirname, '..');
const syncScript = resolve(root, 'scripts/sync-to-opensource.sh');

describe('public API build projection', { skip: !existsSync(syncScript) }, () => {
  const sourcePackage = JSON.parse(readFileSync(resolve(root, 'packages/api/package.json'), 'utf8'));

  function projectPackage(pkg) {
    const directory = mkdtempSync(resolve(tmpdir(), 'public-api-build-'));
    const packagePath = resolve(directory, 'package.json');
    try {
      const source = readFileSync(syncScript, 'utf8');
      const transform = source.match(/<<'API_PACKAGE_JSON_TRANSFORM_EOF'\n([\s\S]*?)\nAPI_PACKAGE_JSON_TRANSFORM_EOF/);
      assert.ok(transform, 'execute the real API package export transform');
      writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
      const before = readFileSync(packagePath, 'utf8');
      const result = spawnSync(process.execPath, ['-', packagePath], {
        input: transform[1],
        encoding: 'utf8',
      });
      return { ...result, before, after: readFileSync(packagePath, 'utf8') };
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  it('preserves the exact canonical build, including Collective Service, and only removes its wrapper key', () => {
    const result = projectPackage(sourcePackage);
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    const actualBuild = sourcePackage.scripts['build:actual'];
    assert.equal(JSON.parse(result.after).scripts.build, actualBuild);
    assert.match(JSON.parse(result.after).scripts.build, /pnpm --dir \.\.\/collective-service build/);
    const expected = structuredClone(sourcePackage);
    expected.scripts.build = actualBuild;
    delete expected.scripts['build:actual'];
    assert.deepEqual(JSON.parse(result.after), expected);
  });

  it('preserves newly added portable build steps without reconstructing a dependency list', () => {
    const pkg = structuredClone(sourcePackage);
    pkg.scripts['build:actual'] += ' && pnpm --dir ../future-component build';
    const result = projectPackage(pkg);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.after).scripts.build, pkg.scripts['build:actual']);
  });

  for (const actualBuild of [
    undefined,
    '',
    42,
    'node ../../scripts/gate-prepared-artifacts.mjs run --artifact api -- tsc',
    'pnpm run build:actual',
    'pnpm run build',
    'tsc && cp src/catalog.json dist/catalog.json',
    'tsc; echo skipped-build',
  ]) {
    it(`rejects a missing or non-portable canonical build before writing: ${JSON.stringify(actualBuild)}`, () => {
      const pkg = structuredClone(sourcePackage);
      pkg.scripts['build:actual'] = actualBuild;
      const result = projectPackage(pkg);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /public API build.*build:actual/);
      assert.equal(result.after, result.before, 'invalid source must not produce a partial package');
    });
  }

  it('projects all prepared TypeScript packages to native public builds while retaining test consumers', (t) => {
    const directory = mkdtempSync(resolve(tmpdir(), 'public-prepared-packages-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const packages = new Map(
      ['shared', 'finance', 'mcp-server'].map((name) => [
        name,
        JSON.parse(readFileSync(resolve(root, 'packages', name, 'package.json'), 'utf8')),
      ]),
    );
    for (const [name, pkg] of packages) {
      const target = resolve(directory, 'packages', name);
      mkdirSync(target, { recursive: true });
      writeFileSync(resolve(target, 'package.json'), JSON.stringify(pkg));
    }
    const source = readFileSync(syncScript, 'utf8');
    // Execute the real shell loops too: a correct heredoc with a missing
    // package invocation would leave that package's private wrapper exported.
    const sharedBlock = source.slice(source.indexOf('# 3k-3a0:'), source.indexOf('# 3k-3a1a:'));
    const mcpBlock = source.slice(source.indexOf('# 3k-3a1c:'), source.indexOf('# 3k-3a2:'));
    assert.ok(sharedBlock && mcpBlock);
    const result = spawnSync('bash', ['-e'], {
      input: `TRANSFORM_COUNT=0\n${sharedBlock}\n${mcpBlock}`,
      env: { ...process.env, FILTERED_DIR: directory },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    for (const [name, pkg] of packages) {
      const expected = structuredClone(pkg);
      expected.scripts.build = 'tsc';
      if (name === 'mcp-server') {
        delete expected.scripts['governance:attest-bootstrap'];
        assert.equal(typeof expected.scripts['governance:write'], 'string');
        assert.equal(typeof expected.scripts['governance:check'], 'string');
      }
      assert.deepEqual(
        JSON.parse(readFileSync(resolve(directory, 'packages', name, 'package.json'), 'utf8')),
        expected,
      );
    }
  });
});
