import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { posix, resolve } from 'node:path';
import { describe, test } from 'node:test';
import ts from 'typescript';
import { pageActionTestFiles } from '../packages/api/scripts/run-page-action-tests.mjs';
import { rootCheckChain } from './lib/root-check-chain.mjs';
import { isCoveredByPublicExport, loadPublicExportCoverage } from './lib/sync-public-export-coverage.mjs';

const root = resolve(import.meta.dirname, '..');
const coverage = loadPublicExportCoverage(root);
const testRoot = 'packages/api/test';

function moduleSpecifier(node) {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return node.moduleSpecifier;
  if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) return node.arguments[0];
}

function localSourcePath(repoRoot, path) {
  const source = path.replace(/\.js$/, '.ts');
  return !existsSync(resolve(repoRoot, path)) && existsSync(resolve(repoRoot, source)) ? source : path;
}

function relativeImports(file, repoRoot = root) {
  const ast = ts.createSourceFile(file, readFileSync(resolve(repoRoot, file), 'utf8'), ts.ScriptTarget.Latest);
  const imports = [];
  function visit(node) {
    const specifier = moduleSpecifier(node);
    if (specifier && ts.isStringLiteralLike(specifier) && specifier.text.startsWith('.')) {
      const path = posix.normalize(posix.join(posix.dirname(file), specifier.text));
      imports.push(localSourcePath(repoRoot, path));
    }
    // The isolated Host resolves these modules with join(projectRoot, literal),
    // so a static-import-only scan cannot see this real runtime edge.
    if (ts.isStringLiteralLike(node) && node.text.startsWith('scripts/f317-page-action/')) imports.push(node.text);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return [...new Set(imports)];
}

function traversable(file) {
  return ['scripts/f317-page-action/', `${testRoot}/helpers/`, 'packages/api/src/'].some((path) =>
    file.startsWith(path),
  );
}

function dependencyClosure(seeds, repoRoot, graph = new Map()) {
  const pending = [...seeds];
  const visited = new Set();
  while (pending.length) {
    const file = pending.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    if (!existsSync(resolve(repoRoot, file))) continue;
    if (!graph.has(file)) graph.set(file, relativeImports(file, repoRoot));
    pending.push(...graph.get(file).filter(traversable));
  }
  return visited;
}

function assertHelperConsumersSelected(repoRoot, selected, exportCoverage) {
  const graph = new Map();
  for (const name of readdirSync(resolve(repoRoot, testRoot))) {
    if (!name.startsWith('f317-') || !name.endsWith('.test.mjs')) continue;
    const file = `${testRoot}/${name}`;
    if (!isCoveredByPublicExport(file, exportCoverage)) continue;
    const consumes = [...dependencyClosure([file], repoRoot, graph)].some((path) =>
      path.startsWith('scripts/f317-page-action/'),
    );
    if (consumes) {
      assert.ok(selected.has(file), `entry omits ${file}`);
    }
  }
}

describe('source-owned F317 export closure', { skip: !coverage && 'sync-manifest is source-only' }, () => {
  test('exported F317 mjs regressions retain their synthetic browser helper closure', () => {
    const seeds = readdirSync(resolve(root, testRoot))
      .filter((name) => name.startsWith('f317-') && name.endsWith('.test.mjs'))
      .map((name) => `${testRoot}/${name}`)
      .filter((file) => isCoveredByPublicExport(file, coverage));
    const graph = new Map();
    dependencyClosure(seeds, root, graph);
    const missing = [];
    for (const [file, dependencies] of graph) {
      for (const dependency of dependencies) {
        if (!isCoveredByPublicExport(dependency, coverage)) missing.push(`${file} -> ${dependency}`);
      }
    }
    assert.deepEqual(missing.sort(), [], `Missing F317 export dependencies:\n${missing.sort().join('\n')}`);
  });

  test('historical lineage reports and model replay stay source-only', () => {
    for (const file of [
      `${testRoot}/f317-page-action-lineage.test.mjs`,
      'docs/evidence/f317/2026-09-28-page-action-jev.json',
      'docs/evidence/f317/2026-09-28-page-action-sol.json',
      'scripts/f317-page-action/cases.mjs',
      'scripts/f317-page-action/model-prompts.mjs',
      'scripts/f317-page-action/model-selectors.mjs',
      'scripts/f317-page-action/replay.mjs',
    ])
      assert.equal(isCoveredByPublicExport(file, coverage), false, `${file} must remain source-only`);
  });

  test('the dedicated entry selects every exported helper consumer, including the indirect fixture and optional lab', () => {
    const selected = new Set(pageActionTestFiles(true).map((file) => `packages/api/${file}`));
    assertHelperConsumersSelected(root, selected, coverage);
    assert.ok(selected.has(`${testRoot}/f317-current-page-browser.test.mjs`));
    assert.ok(selected.has(`${testRoot}/f317-owner-local-note-lab.test.mjs`));
    assert.ok(selected.has(`${testRoot}/f317-owner-local-note-simulation.test.mjs`));
    assert.ok(!pageActionTestFiles().includes('test/f317-owner-local-note-lab.test.mjs'));
    assert.ok(!selected.has(`${testRoot}/f317-page-action-lineage.test.mjs`));
    assert.ok(isCoveredByPublicExport('packages/api/test/fixtures/f317-page-action.html', coverage));
  });
});

test('the export guard is invoked by the installed root check chain', () => {
  const scripts = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).scripts;
  assert.match(rootCheckChain(scripts), /pnpm check:env-ports/);
  assert.ok(scripts['check:env-ports'].includes('scripts/f317-page-action-export.test.mjs'));
});

test('a newly exported indirect fixture or dynamic Host consumer cannot be omitted from the entry', () => {
  const fixture = mkdtempSync(resolve(tmpdir(), 'f317-indirect-consumer-'));
  function write(file, text) {
    mkdirSync(resolve(fixture, posix.dirname(file)), { recursive: true });
    writeFileSync(resolve(fixture, file), text);
  }
  try {
    write(
      'sync-manifest.yaml',
      'managed_roots:\n  - packages/api\nmanaged_scripts:\n  - scripts/f317-page-action/browser-binary.mjs\n',
    );
    write('scripts/f317-page-action/browser-binary.mjs', 'export const binary = 1;');
    write(
      `${testRoot}/helpers/page.mjs`,
      "export { binary } from '../../../../scripts/f317-page-action/browser-binary.mjs';",
    );
    const indirect = `${testRoot}/f317-indirect.test.mjs`;
    write(indirect, "import './helpers/page.mjs';");
    assert.throws(
      () => assertHelperConsumersSelected(fixture, new Set(), loadPublicExportCoverage(fixture)),
      /entry omits packages\/api\/test\/f317-indirect/,
    );
    write(
      'packages/api/src/lab.ts',
      "import { join } from 'node:path'; export const binary = join(root, 'scripts/f317-page-action/browser-binary.mjs');",
    );
    const dynamic = `${testRoot}/f317-dynamic.test.mjs`;
    write(dynamic, "import '../src/lab.js';");
    assert.throws(
      () => assertHelperConsumersSelected(fixture, new Set([indirect]), loadPublicExportCoverage(fixture)),
      /entry omits packages\/api\/test\/f317-dynamic/,
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
