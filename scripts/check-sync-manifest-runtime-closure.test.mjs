import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, join, normalize, relative, resolve, sep } from 'node:path';
import { describe, it } from 'node:test';

import YAML from 'yaml';

import { resolvePublicTestFiles } from '../packages/api/scripts/resolve-public-test-files.mjs';

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

  it('claims ownership of the public release notes template', () => {
    // Regression guard for clowder-ai#1370: this template existed in both source and
    // clowder-ai main, but was absent from every manifest list — neither exported nor
    // protected. A full sync therefore shipped an export that did not contain it,
    // silently deleting a public release asset from the open-source repo.
    // It must stay explicitly owned: exported (source-owned) OR target-owned, never
    // unclaimed.
    const template = '.github/release-notes-template.md';
    const targetOwned = new Set(manifest.target_owned_files ?? []);

    assert.ok(
      isExported(template) || targetOwned.has(template),
      `${template} must be explicitly owned by the manifest (exported or target-owned), otherwise full sync deletes it from the public repo`,
    );

    // Current decision: source-owned + sanitized on export (target is the public brand
    // variant of the source file). If this is ever flipped to target-owned, drop the
    // assertions below together with the managed_files entry — but never leave it in
    // neither list.
    assert.ok(managedFiles.has(template), `${template} must be listed in managed_files`);
    assert.ok(!targetOwned.has(template), `${template} is source-owned and must not also be target-owned`);
    assert.ok(!excluded.has(template), `${template} must not be excluded from export`);
  });

  it('protects community-contributed assets from sync deletion', () => {
    // Regression guard for clowder-ai#1370 (F251 Layer 1, 2026-08-18): these paths were
    // introduced into the open-source repo by community PRs (bug reports, feature specs,
    // review notes, eval bundles, community-only tests). The matching source directories
    // are `excluded` (internal docs are not published), so the export never contains them.
    // Without an explicit target-owned claim, a full sync treats them as "should delete"
    // and wipes community-authored work — the clowder-ai#290 incident shape.
    //
    // These must stay target-owned. They must NOT be exported: that would either publish
    // internal documents or create an export obligation the source cannot honour.
    // Two groups, because target_owned_files is enforced by backup → sync → restore:
    // it protects a path even when that path sits inside a managed_root.
    //
    // Group A — internal-doc directories that are `excluded` on the source side. These
    // must additionally never be exported, or we would publish internal documents.
    const communityDocs = ['docs/bug-report/', 'review-notes/', 'feature-specs/', 'docs/plans/'];
    // Group B — community evaluation evidence whose public verdicts have already diverged
    // from their post-intake source copies. Keep the public evidence intact and do not
    // accidentally turn these exact artifacts into a broader export obligation.
    const communityEvidence = [
      'docs/harness-feedback/bundles/2026-06-30-eval-a2a-no-data-telemetry-gap-build/',
      'docs/harness-feedback/bundles/2026-06-30-eval-friction-c1-empty-window-after-singleton/',
      'docs/harness-feedback/verdicts/2026-06-30-eval-a2a-no-data-telemetry-gap-build.md',
      'docs/harness-feedback/verdicts/2026-06-30-eval-friction-c1-empty-window-after-singleton.md',
    ];
    // Group C — community-only files living inside an exported root (packages/api).
    // isExported() is rule-based, so it reports true for anything under a managed_root;
    // the real protection here is backup/restore, so only ownership is asserted.
    const communityFiles = [
      'packages/api/test/dual-path-strict-equality.test.js',
      'packages/api/test/opencode-model-id-ci-contract.test.js',
      'packages/api/test/redis-task-progress-store.test.js',
    ];
    const targetOwned = new Set(manifest.target_owned_files ?? []);

    for (const path of [...communityDocs, ...communityEvidence, ...communityFiles]) {
      assert.ok(
        targetOwned.has(path),
        `${path} carries community-contributed content and must be target-owned, otherwise full sync deletes it`,
      );
    }
    for (const path of [...communityDocs, ...communityEvidence]) {
      assert.ok(!isExported(path), `${path} is target-owned evidence and must not be exported`);
    }

    // clowder-ai#1075 also authored this one-time migration script, but the source repo
    // explicitly absorbed the exact blob in intake commit 42e97cdf. Intake transfers
    // source ownership: exporting it prevents deletion without freezing future source
    // corrections behind a target-owned claim.
    const absorbedScript = 'scripts/generate-hook-manifests.mjs';
    assert.ok(managedScripts.has(absorbedScript), `${absorbedScript} must remain in managed_scripts after intake`);
    assert.ok(isExported(absorbedScript), `${absorbedScript} must be exported from the source truth`);
    assert.ok(!targetOwned.has(absorbedScript), `${absorbedScript} must not be both source-owned and target-owned`);
    assert.ok(!excluded.has(absorbedScript), `${absorbedScript} must not be excluded from export`);
  });

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

  it('exports every direct local import of a selected public API test', async () => {
    const { selectedFiles } = await resolvePublicTestFiles();
    const missing = [];

    for (const publicTest of selectedFiles) {
      const importer = `packages/api/${publicTest}`;
      const source = readFileSync(resolve(ROOT, importer), 'utf8');
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
      `sync-manifest omits direct public-test dependencies:\n${[...new Set(missing)].sort().join('\n')}`,
    );
  });

  it('exports the shell helper sourced by the public sync-skills CLI', () => {
    const cli = 'scripts/sync-skills.sh';
    const helper = 'scripts/lib/sync-skills-helpers.sh';
    const source = readFileSync(resolve(ROOT, cli), 'utf8');

    assert.ok(managedScripts.has(cli), `${cli} must remain exported`);
    assert.match(
      source,
      /source "\$SCRIPT_DIR\/lib\/sync-skills-helpers\.sh"/,
      `${cli} must bind the helper path exercised by this closure contract`,
    );
    assert.ok(
      managedScripts.has(helper),
      `${helper} must be exported with ${cli}, otherwise the public CLI exits before parsing its arguments`,
    );
  });

  it('exports the project post-compact hook exercised by the public F296 contract', () => {
    const contract = 'packages/api/test/f296-b3b3-post-compact-hook.test.js';
    const hook = '.claude/hooks/f24-post-compact-bootstrap.sh';
    const source = readFileSync(resolve(ROOT, contract), 'utf8');

    assert.match(
      source,
      /join\(REPO_ROOT, '\.claude\/hooks\/f24-post-compact-bootstrap\.sh'\)/,
      `${contract} must stay bound to the real project hook`,
    );
    assert.ok(
      managedFiles.has(hook),
      `${hook} must be exported with ${contract}, otherwise the public suite cannot exercise the cold-packet boundary`,
    );
    assert.ok(!excluded.has(hook), `${hook} must not be excluded from the public filtered tree`);
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

  it('does not make public magic-word tests depend on private L0 staging content', () => {
    const stagingRef = 'cat-cafe-skills/refs/l0-staging-content.md';
    const magicWordTest = readFileSync(
      resolve(ROOT, 'packages/api/test/harness-eval/task-outcome-magic-word-detector.test.js'),
      'utf8',
    );
    const eventsRouteTest = readFileSync(resolve(ROOT, 'packages/api/test/events-route.test.js'), 'utf8');

    assert.ok(excluded.has(stagingRef), 'raw L0 staging content must remain private in public exports');
    assert.match(
      magicWordTest,
      /skip:\s*!existsSync\(STAGING_CONTENT_URL\)/,
      'the full home-governance parity assertion must skip when private L0 staging content is absent',
    );
    assert.match(
      eventsRouteTest,
      /if\s*\(hasSourceStagingContent\)[\s\S]*staging 四象限 meaning present[\s\S]*assert\.equal\(quadrants,\s*undefined/,
      'the meanings endpoint test must require private meanings at home and require their absence publicly',
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
