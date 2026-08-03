import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, join, normalize, relative, resolve, sep } from 'node:path';
import { describe, it } from 'node:test';

import YAML from 'yaml';

const ROOT = resolve(import.meta.dirname, '..');
const MANIFEST_PATH = resolve(ROOT, 'sync-manifest.yaml');
const isHomeRepo = existsSync(MANIFEST_PATH);

function toRepoPath(absolutePath) {
  return relative(ROOT, absolutePath).split(sep).join('/');
}

function resolveLocalImport(importer, specifier) {
  const base = normalize(resolve(dirname(resolve(ROOT, importer)), specifier));
  const candidates = extname(base)
    ? [base]
    : [base, `${base}.mjs`, `${base}.js`, `${base}.json`, join(base, 'index.mjs'), join(base, 'index.js')];
  return candidates.find((candidate) => existsSync(candidate)) ?? base;
}

function collectRelativeImports(source) {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const specifiers = new Set();
  const staticImport = /(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"](\.[^'"]+)['"]/g;
  const dynamicImport = /import\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g;

  for (const pattern of [staticImport, dynamicImport]) {
    for (const match of code.matchAll(pattern)) specifiers.add(match[1]);
  }
  return [...specifiers];
}

describe('outbound sync runtime closure', { skip: !isHomeRepo && 'sync manifest is home-repo-only' }, () => {
  const manifest = isHomeRepo ? YAML.parse(readFileSync(MANIFEST_PATH, 'utf8')) : {};
  const managedRoots = new Set(manifest.managed_roots ?? []);
  const managedFiles = new Set(manifest.managed_files ?? []);
  const managedScripts = new Set(manifest.managed_scripts ?? []);
  const excluded = new Set(manifest.excluded ?? []);

  function isExported(repoPath) {
    if (managedFiles.has(repoPath) || managedScripts.has(repoPath)) return true;
    return [...managedRoots].some((root) => repoPath === root || repoPath.startsWith(`${root}/`));
  }

  it('exports every direct local import of an exported script', () => {
    const missing = [];

    for (const importer of managedScripts) {
      if (!/\.(?:mjs|js)$/.test(importer)) continue;
      const importerPath = resolve(ROOT, importer);
      if (!existsSync(importerPath)) continue;

      const source = readFileSync(importerPath, 'utf8');
      for (const specifier of collectRelativeImports(source)) {
        const dependency = resolveLocalImport(importer, specifier);
        const dependencyPath = toRepoPath(dependency);
        assert.ok(
          !dependencyPath.startsWith('../'),
          `${importer} imports local module outside the repository: ${specifier}`,
        );
        if (!isExported(dependencyPath)) missing.push(`${importer} -> ${dependencyPath}`);
      }
    }

    assert.deepEqual(
      [...new Set(missing)].sort(),
      [],
      `sync-manifest omits direct runtime dependencies:\n${[...new Set(missing)].sort().join('\n')}`,
    );
  });

  it('exports the prompt-hook manifests scanned by PipelinePromptBuilder', () => {
    const builder = readFileSync(
      resolve(ROOT, 'packages/api/src/domains/prompt-hooks/PipelinePromptBuilder.ts'),
      'utf8',
    );
    assert.match(builder, /join\(root, 'assets', 'prompt-hooks'\)/, 'test must bind the real runtime scan path');
    assert.ok(
      managedRoots.has('assets/prompt-hooks'),
      'sync-manifest must export assets/prompt-hooks because the public runtime scans it',
    );
  });

  it('exports the embedding policy probe executed by the public API regression test', () => {
    const policyTest = readFileSync(resolve(ROOT, 'packages/api/test/embed-runtime-policy.test.js'), 'utf8');
    assert.match(
      policyTest,
      /scripts\/services\/test_embed_runtime_policy\.py/,
      'test must bind the real policy probe path',
    );
    assert.ok(
      managedScripts.has('scripts/services/test_embed_runtime_policy.py'),
      'sync-manifest must export the Python policy probe used by embed-runtime-policy.test.js',
    );
    assert.match(
      readFileSync(resolve(ROOT, 'scripts/services/test_embed_runtime_policy.py'), 'utf8'),
      /from embed_runtime_policy import/,
      'policy probe must bind its sibling runtime module',
    );
    assert.ok(
      managedScripts.has('scripts/services/embed_runtime_policy.py'),
      'sync-manifest must export the runtime module imported by the Python policy probe',
    );
  });

  it('does not make the public review guard depend on the home-only inbound playbook', () => {
    const guard = readFileSync(resolve(ROOT, 'scripts/check-external-review-closure.mjs'), 'utf8');
    const inboundRef = 'cat-cafe-skills/refs/opensource-ops-inbound-pr.md';

    assert.ok(existsSync(resolve(ROOT, inboundRef)), 'the home repository must retain its inbound maintainer playbook');
    assert.ok(excluded.has(inboundRef), 'the private maintainer playbook must remain excluded from public export');
    assert.match(
      guard,
      /inboundPrReference:\s*readIfPresent\('cat-cafe-skills\/refs\/opensource-ops-inbound-pr\.md'\)/,
      'the exported checker must skip only the absent home-only continuity surface',
    );

    for (const consumer of [
      'scripts/check-skill-first-party-surfaces.test.mjs',
      'scripts/clowder-merge-execution.test.mjs',
    ]) {
      const source = readFileSync(resolve(ROOT, consumer), 'utf8');
      assert.match(
        source,
        /skip:\s*!existsSync\(INBOUND_RUNBOOK_URL\)/,
        `${consumer} must skip the home-only assertion publicly`,
      );
    }

    assert.match(
      readFileSync(resolve(ROOT, 'scripts/services/whisper-dispatch.test.mjs'), 'utf8'),
      /skip:\s*!existsSync\(SYNC_MANIFEST\)/,
      'the exported ASR suite must skip only its source-owned manifest assertion publicly',
    );

    const publicReads = [...guard.matchAll(/\bread\('([^']+)'\)/g)]
      .map((match) => match[1])
      .filter((path) => path !== inboundRef);
    assert.deepEqual(
      publicReads.filter((path) => !isExported(path)),
      [],
      'every other literal file read by the public review guard must be in the export closure',
    );
  });

  it('stages tracked paths losslessly before applying the manifest', () => {
    const syncScript = readFileSync(resolve(ROOT, 'scripts/sync-to-opensource.sh'), 'utf8');
    assert.match(
      syncScript,
      /git -C "\$SOURCE_DIR" ls-files -z --cached --others --exclude-standard \| while IFS= read -r -d '' f/,
      'working-tree export must use NUL-delimited git paths so Unicode hook directories are not skipped',
    );
  });
});
