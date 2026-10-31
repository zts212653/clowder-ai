import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { it } from 'node:test';
import { rootCheckChain } from '../lib/root-check-chain.mjs';
import { extractScriptRefs, ROOT, readJsonFile, readYamlTopLevelList } from './context.mjs';
import { buildExportedRootScripts, executePackageScriptsTransform } from './exported-scripts.mjs';

export function registerSyncTransformPart2() {
  it('sync-manifest exports release-desktop reusable workflow closure', () => {
    const managedFiles = readYamlTopLevelList('sync-manifest.yaml', 'managed_files');
    const releaseDesktop = readFileSync(resolve(ROOT, '.github/workflows/release-desktop.yml'), 'utf-8');
    const workflowRefs = Array.from(
      releaseDesktop.matchAll(/uses:\s+\.\/(\.github\/workflows\/[A-Za-z0-9_.-]+\.yml)/g),
      (match) => match[1],
    );

    assert.notEqual(
      workflowRefs.length,
      0,
      'release-desktop.yml should reference reusable workflows so this guard verifies a real closure',
    );

    for (const workflowPath of workflowRefs) {
      assert.ok(
        managedFiles.includes(workflowPath),
        `sync-manifest should export ${workflowPath} because release-desktop.yml uses it`,
      );
    }
  });

  it('sync-manifest exports start-dev sourced shell closure', () => {
    const managedScripts = readYamlTopLevelList('sync-manifest.yaml', 'managed_scripts');
    const requiredScripts = [
      'scripts/start-dev.sh',
      'scripts/download-source-overrides.sh',
      'scripts/lib/node-runtime-guard.sh',
      'scripts/lib/redis-rdb-first.sh',
    ];

    for (const scriptPath of requiredScripts) {
      assert.ok(
        managedScripts.includes(scriptPath),
        `sync-manifest should export ${scriptPath} because public start-dev.sh sources it at runtime`,
      );
    }
  });

  it('sync-manifest exports public pre-merge check script closure', () => {
    const managedScripts = readYamlTopLevelList('sync-manifest.yaml', 'managed_scripts');
    const requiredScripts = [
      'scripts/pre-merge-check.sh',
      'scripts/pre-merge-check.test.mjs',
      'scripts/pre-merge-gate-guard.mjs',
      'scripts/pre-merge-gate-guard.test.mjs',
      'scripts/lib/fseventsd-pressure.mjs',
      'scripts/lib/fseventsd-pressure.test.mjs',
      'scripts/write-gate-last-run.sh',
    ];

    for (const scriptPath of requiredScripts) {
      assert.ok(
        managedScripts.includes(scriptPath),
        `sync-manifest should export ${scriptPath} because public check:pre-merge-gate executes it`,
      );
    }
  });

  it('source pre-merge gate executes the fseventsd threshold policy suite', () => {
    const sourcePkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8'));
    assert.match(sourcePkg.scripts['check:pre-merge-gate'], /scripts\/lib\/fseventsd-pressure\.test\.mjs/);
  });

  it('source/public check:pre-merge-gate do not drift — every exported source test runs publicly', () => {
    // cloud P2-3 (cat-cafe#2846): source check:pre-merge-gate gained tests (classify-merge-outcome,
    // check-worktree-dirty-ledger) but the public transform (sync-to-opensource.sh + the
    // buildExportedRootScripts mirror) still hard-coded an older 3-test list — so the open-source
    // gate exported the regression tests as files but never executed them. Guard BOTH the test
    // mirror and the real shell transform against source drift.
    const sourcePkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8'));
    const managedScripts = new Set(readYamlTopLevelList('sync-manifest.yaml', 'managed_scripts'));
    const extractTests = (cmd) => cmd.match(/scripts\/[\w/-]+\.test\.mjs/g) ?? [];
    const exportedSourceTests = extractTests(sourcePkg.scripts['check:pre-merge-gate']).filter((t) =>
      managedScripts.has(t),
    );
    assert.ok(exportedSourceTests.length > 0, 'source check:pre-merge-gate should reference exported tests');

    const publicMirror = buildExportedRootScripts(sourcePkg.scripts)['check:pre-merge-gate'];
    const shTransform = readFileSync(resolve(ROOT, 'scripts/sync-to-opensource.sh'), 'utf-8');
    for (const testPath of exportedSourceTests) {
      assert.ok(
        publicMirror.includes(testPath),
        `buildExportedRootScripts public check:pre-merge-gate must run exported source test ${testPath}`,
      );
      assert.ok(
        shTransform.includes(testPath),
        `sync-to-opensource.sh public check:pre-merge-gate must run exported source test ${testPath}`,
      );
    }
  });

  it('public check:pre-merge-gate references only scripts exported by sync-manifest', () => {
    const sourcePkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8'));
    const managedScripts = new Set(readYamlTopLevelList('sync-manifest.yaml', 'managed_scripts'));
    const publicMirror = buildExportedRootScripts(sourcePkg.scripts)['check:pre-merge-gate'];
    const shTransform = readFileSync(resolve(ROOT, 'scripts/sync-to-opensource.sh'), 'utf-8');
    const transformedCommand = shTransform.match(/pkg\.scripts\["check:pre-merge-gate"\]\s*=\s*"([^"]+)";/)?.[1];

    assert.ok(transformedCommand, 'sync-to-opensource.sh should assign public check:pre-merge-gate');
    for (const [surface, command] of [
      ['buildExportedRootScripts mirror', publicMirror],
      ['sync-to-opensource.sh transform', transformedCommand],
    ]) {
      const unexportedScripts = extractScriptRefs(command).filter((scriptPath) => !managedScripts.has(scriptPath));
      assert.deepEqual(unexportedScripts, [], `${surface} must not reference unexported scripts`);
    }
  });

  it('sync-manifest does not protect managed service wrappers as target-owned', () => {
    const managedScripts = readYamlTopLevelList('sync-manifest.yaml', 'managed_scripts');
    const targetOwnedFiles = readYamlTopLevelList('sync-manifest.yaml', 'target_owned_files');
    const managedServiceWrappers = managedScripts.filter((entry) => entry.startsWith('scripts/services/'));

    for (const entry of targetOwnedFiles) {
      const overlappingManaged = managedServiceWrappers.find(
        (managed) => managed === entry || managed.startsWith(entry),
      );
      assert.equal(
        overlappingManaged,
        undefined,
        `target_owned_files should not restore over managed public service wrapper ${overlappingManaged ?? entry}`,
      );
    }
  });

  it('sync-to-opensource.sh keeps exported root package script surfaces closed', (t) => {
    const content = readFileSync(resolve(ROOT, 'scripts/sync-to-opensource.sh'), 'utf-8');
    const exportedScripts = buildExportedRootScripts(readJsonFile('package.json').scripts);
    const directory = mkdtempSync(resolve(tmpdir(), 'public-root-checks-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const packagePath = resolve(directory, 'package.json');
    writeFileSync(packagePath, JSON.stringify(readJsonFile('package.json')));
    const transform = content.match(/<<'PACKAGE_JSON_TRANSFORM_EOF'\n([\s\S]*?)\nPACKAGE_JSON_TRANSFORM_EOF/);
    assert.ok(transform, 'execute the actual root package projection');
    execFileSync(process.execPath, ['-', packagePath], { input: transform[1] });
    const actualScripts = JSON.parse(readFileSync(packagePath, 'utf8')).scripts;
    assert.ok(!Object.keys(actualScripts).some((name) => name.endsWith(':after-api-tests')));
    assert.ok(!Object.values(actualScripts).some((command) => command.includes(':after-api-tests')));

    assert.ok(
      !content.includes('pkg.scripts.check === "node scripts/run-checks.mjs"'),
      'public package transform must consume the canonical inline check chain without a dead runner compatibility branch',
    );
    assert.ok(
      content.includes('pkg.scripts["check:pre-merge-gate"] ='),
      'public package.json should keep only exported source tests in check:pre-merge-gate',
    );
    assert.ok(
      rootCheckChain(exportedScripts).split(' && ').includes('pnpm check:skills:surfaces') &&
        !content.includes('"check:skills:surfaces",'),
      'public package.json should run the exported skill surface guard in pnpm check',
    );
    // A tier may keep calling a script the transform deleted; the literal
    // `check` string would never show it. Every step `pnpm check` reaches
    // must resolve to a script that still exists in the public package.
    for (const step of rootCheckChain(exportedScripts).split(' && ')) {
      const match = /^pnpm (?:run )?([\w:.-]+)$/u.exec(step);
      if (!match || match[1] === 'biome') continue;
      assert.ok(exportedScripts[match[1]], `public pnpm check reaches a deleted script: ${step}`);
    }
    assert.ok(
      content.includes('delete pkg.scripts["check:architecture-ownership"]'),
      'public package.json should not expose check:architecture-ownership without exporting its script target',
    );
    assert.ok(
      content.includes('delete pkg.scripts["test:architecture-ownership"]'),
      'public package.json should not expose test:architecture-ownership without exporting its script target',
    );
    assert.ok(
      content.includes('.filter((segment) => segment !== "pnpm test:architecture-ownership")') &&
        !rootCheckChain(exportedScripts).split(' && ').includes('pnpm test:architecture-ownership'),
      'public package.json should remove the source-only architecture ownership test from every check chain',
    );
    assert.ok(
      content.includes('"check:f223-action-tracking"'),
      'public package.json should drop source-only F223 action tracking because its inventory truth source is not exported',
    );
    assert.ok(
      content.includes('"check:docs-discovery"'),
      'public package.json should drop source-only docs discovery checks because public docs export is partial',
    );
    assert.ok(
      content.includes('"check:measurement-bundles"'),
      'public package.json should drop the home-only measurement bundle audit because public evidence is partial',
    );
    assert.ok(
      content.includes('"check:measurement-component-hashes"') &&
        !exportedScripts['check:measurement-component-hashes'] &&
        !exportedScripts['check:features'].includes('check:measurement-component-hashes'),
      'public package.json should remove the home-only component hash audit from both its definition and nested feature chain',
    );
    assert.ok(
      content.includes('"eval:post-checkout-guard"') && !exportedScripts['eval:post-checkout-guard'],
      'public package.json should drop the home-only primary-worktree guard evaluator',
    );
    assert.ok(
      !content.includes('"check:biome-version",'),
      'public package.json should keep check:biome-version because public hooks/pre-merge call it',
    );
  });

  it('public package transform strips home-only memory architecture executables', () => {
    const sourceScripts = readJsonFile('package.json').scripts;
    const transformedScripts = executePackageScriptsTransform(sourceScripts);
    const mirroredScripts = buildExportedRootScripts(sourceScripts);
    const homeOnlyScripts = [
      'gate:shared-red',
      'gen:memory-architecture-closure',
      'check:memory-architecture-catalog',
      'gate:memory-architecture-closure',
    ];

    for (const scriptName of homeOnlyScripts) {
      assert.equal(
        transformedScripts[scriptName],
        undefined,
        `${scriptName} depends on unpublished lane manifests and must not be advertised publicly`,
      );
      assert.equal(mirroredScripts[scriptName], transformedScripts[scriptName], `${scriptName} mirror drift`);
    }
    assert.doesNotMatch(
      transformedScripts.check,
      /check:memory-architecture-catalog/,
      'public pnpm check must not invoke a catalog checker whose lane manifests are intentionally not published',
    );
    assert.doesNotMatch(mirroredScripts.check, /check:memory-architecture-catalog/, 'public check-chain mirror drift');
  });

  it('public package transform and its test mirror agree on every exported root script (drift guard)', () => {
    // #4686 review P2: the shell transform grew an internalScripts entry while the mirror did not,
    // and every other assertion stayed green. Compare the two whole outputs on the real package.json
    // so a one-sided edit turns red by itself.
    const sourceScripts = readJsonFile('package.json').scripts;
    assert.deepEqual(
      buildExportedRootScripts(sourceScripts),
      executePackageScriptsTransform(sourceScripts),
      'buildExportedRootScripts must mirror the PACKAGE_JSON_TRANSFORM_EOF program in scripts/sync-to-opensource.sh — update both when adding an internal-only script',
    );
  });

  it('normalizes parent-relative script references from their package root', () => {
    assert.deepEqual(
      extractScriptRefs(
        'node ./scripts/local.mjs && node ../../scripts/root.mjs && bash "../../scripts/verify.sh"',
        'packages/api',
      ),
      ['packages/api/scripts/local.mjs', 'scripts/root.mjs', 'scripts/verify.sh'],
    );
  });
}
