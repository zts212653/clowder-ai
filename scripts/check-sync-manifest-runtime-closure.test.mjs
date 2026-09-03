import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, relative, resolve, sep } from 'node:path';
import { describe, it } from 'node:test';

import ts from 'typescript';
import YAML from 'yaml';

import { resolvePublicTestFiles } from '../packages/api/scripts/resolve-public-test-files.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const MANIFEST_PATH = resolve(ROOT, 'sync-manifest.yaml');
const SYNC_SCRIPT_PATH = resolve(ROOT, 'scripts/sync-to-opensource.sh');
const isHomeRepo = existsSync(MANIFEST_PATH);

function readSanitizedTextExtensions(syncScript) {
  const match = syncScript.match(/^SANITIZED_TEXT_EXTENSIONS=\(([^)]*)\)/m);
  assert.ok(match, 'sync-to-opensource.sh must declare SANITIZED_TEXT_EXTENSIONS');
  return match[1].trim().split(/\s+/).filter(Boolean);
}

// Read the blocking pattern out of the script rather than restating it: a second copy drifts, and
// the literal home-machine token in it is itself rewritten by the sanitizer on export.
function readBlockingScanPattern(syncScript) {
  const match = syncScript.match(/BLOCK_RESULTS=\$\(grep -rEn '([^']+)'/);
  assert.ok(match, 'sync-to-opensource.sh must define the Step 4 blocking grep');
  return match[1];
}

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
  const sourceFile = ts.createSourceFile(
    'exported-script.mjs',
    source,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.JS,
  );
  const specifiers = new Set();

  function visit(node) {
    const moduleSpecifier =
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier
        ? node.moduleSpecifier
        : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
          ? node.arguments[0]
          : undefined;
    if (moduleSpecifier && ts.isStringLiteralLike(moduleSpecifier) && moduleSpecifier.text.startsWith('.')) {
      specifiers.add(moduleSpecifier.text);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
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

  it('exports the portable opensource-ops skill without leaking the home playbook', () => {
    const privateSkill = 'cat-cafe-skills/opensource-ops/SKILL.md';
    const portableSource = 'cat-cafe-skills/opensource-ops/SKILL.opensource.md';
    const transform = (manifest.transforms ?? []).find((entry) => entry.target === privateSkill);
    const syncScript = readFileSync(SYNC_SCRIPT_PATH, 'utf8');
    const privateText = readFileSync(resolve(ROOT, privateSkill), 'utf8');
    const portableText = readFileSync(resolve(ROOT, portableSource), 'utf8');
    const featureText = readFileSync(resolve(ROOT, 'docs/features/F116-opensource-ops.md'), 'utf8');
    const capabilityTips = JSON.parse(
      readFileSync(resolve(ROOT, 'packages/web/src/lib/capability-tips.seed.json'), 'utf8'),
    );
    const communityWorkflowTip = capabilityTips.find((tip) => tip.id === 'workflow-community-decision-queue');

    assert.ok(
      !excluded.has('cat-cafe-skills/opensource-ops/'),
      'the whole directory exclusion would delete the public skill',
    );
    assert.ok(excluded.has(privateSkill), 'the home playbook must remain excluded from direct export');
    assert.ok(excluded.has(portableSource), 'the transform source must not leak under its source filename');
    assert.deepEqual(
      { type: transform?.type, source: transform?.source },
      { type: 'generate', source: portableSource },
      'the public path must be generated from the reviewed portable source',
    );
    assert.match(
      syncScript,
      /SKILL\.opensource\.md"[\s\S]*SKILL\.md"/,
      'the sync runtime must materialize the portable target',
    );
    assert.match(privateText, /Repo Inbox 守门红线/, 'home must retain its deployment-specific maintainer playbook');
    assert.match(portableText, /Server 不替你猜/, 'portable source must own the child-side grounding contract');
    assert.doesNotMatch(portableText, /Repo Inbox 守门红线/, 'portable source must not expose the home-only playbook');
    assert.deepEqual(communityWorkflowTip?.structureSource, {
      path: 'docs/features/F116-opensource-ops.md',
      anchor: '场景 B: Inbound PR（社区 PR 评估 + 合入 + 吸收）',
    });
    assert.deepEqual(communityWorkflowTip?.bodySource, {
      path: privateSkill,
      anchor: '五问',
    });
    assert.match(featureText, /场景 B: Inbound PR（社区 PR 评估 \+ 合入 \+ 吸收）/u);
    assert.match(privateText, /五问/u);
    assert.match(portableText, /五问/u);
  });

  it('keeps public technical-narrative skills independent of the home-only study note', () => {
    const homeMethod = 'docs/study/2026-08-29-technical-narrative-proof-loop-meta-method.md';
    const techWriting = readFileSync(resolve(ROOT, 'cat-cafe-skills/tech-writing/SKILL.md'), 'utf8');
    const conceptDemo = readFileSync(resolve(ROOT, 'cat-cafe-skills/concept-demo-design/SKILL.md'), 'utf8');
    const surfaceTest = readFileSync(resolve(ROOT, 'scripts/check-skill-first-party-surfaces.test.mjs'), 'utf8');

    assert.ok(existsSync(resolve(ROOT, homeMethod)), 'home retains the deep research note as source lineage');
    assert.ok(!isExported(homeMethod), 'the internal research note must not become a public runtime dependency');
    assert.doesNotMatch(
      techWriting,
      /\.\.\/\.\.\/docs\/study\/2026-08-29-technical-narrative-proof-loop-meta-method\.md/u,
    );
    assert.match(techWriting, /本节[^。\n]*7P × 5E/u);
    assert.doesNotMatch(
      conceptDemo,
      /\.\.\/\.\.\/docs\/study\/2026-08-29-technical-narrative-proof-loop-meta-method\.md/u,
    );
    assert.match(conceptDemo, /\.\.\/tech-writing\/SKILL\.md#技术叙事的证据剖面/u);
    assert.match(surfaceTest, /existsSync\(TECHNICAL_NARRATIVE_METHOD_URL\)/u);
  });

  it('keeps public pre-merge tests independent of the home-only prepared-artifact optimizer', () => {
    const preparedArtifactScript = 'scripts/gate-prepared-artifacts.mjs';
    const preMergeTest = readFileSync(resolve(ROOT, 'scripts/pre-merge-check.test.mjs'), 'utf8');

    assert.ok(!isExported(preparedArtifactScript), 'the prepared-artifact optimizer remains home-only');
    assert.match(
      preMergeTest,
      /skip:\s*!existsSync\(PREPARED_ARTIFACT_SCRIPT\)[^\n]*home-only prepared-artifact support is absent from public export/u,
    );
    assert.equal(
      [...preMergeTest.matchAll(/PREPARED_ARTIFACT_TEST_OPTIONS/g)].length,
      5,
      'the option declaration and all four source-only prepared-artifact tests must stay bound together',
    );
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

  it('owns the public site and target companions absorbed from clowder-ai#1405', () => {
    // clowder-ai#1405 introduced the public website as a community contribution.
    // A full sync uses rsync --delete, so every surviving surface needs one explicit
    // owner: source-managed assets are exported from Clowder AI, while deployment and
    // public-document companions are backed up and restored from the target repo.
    const targetOwned = new Set(manifest.target_owned_files ?? []);
    const sourceOwned = [
      ['managed root', 'site', managedRoots],
      ['managed script', 'scripts/build-site-css.mjs', managedScripts],
      ['managed file', 'tailwind.site.config.js', managedFiles],
    ];
    const publicCompanions = [
      '.github/workflows/deploy-pages.yml',
      'docs/architecture/a2a-protocol.md',
      'docs/architecture/overview.md',
      'docs/architecture/plugin-architecture.md',
      'docs/configuration/environment.md',
      'docs/configuration/startup.md',
      'docs/faq.md',
    ];

    for (const [kind, path, ownerSet] of sourceOwned) {
      assert.ok(ownerSet.has(path), `${path} must remain a ${kind} after clowder-ai#1405 intake`);
      assert.ok(isExported(path), `${path} must be exported from the source truth`);
      assert.ok(!targetOwned.has(path), `${path} must not be both source-owned and target-owned`);
      assert.ok(!excluded.has(path), `${path} must not be excluded from export`);
    }
    const gitignore = readFileSync(resolve(ROOT, '.gitignore'), 'utf8');
    assert.match(
      gitignore,
      /^!site\/assets\/guides\/\*\.mp4$/m,
      'community-authored walkthrough videos must remain trackable inside the source-owned site',
    );

    for (const path of publicCompanions) {
      assert.ok(
        targetOwned.has(path),
        `${path} is a public-repository companion from clowder-ai#1405 and must survive full sync`,
      );
    }
  });

  it('protects target-local environment configuration from sync deletion', () => {
    // Production dry-run evidence on 2026-08-24 showed that root `.env.local` is
    // ignored by Git and absent from the source export, so rsync --delete would
    // remove it before a public runtime could be started. The sync contract must
    // carry this deployment-owned file through the same backup → sync → restore
    // path as every other target-owned artifact.
    const localEnvironment = '.env.local';
    const targetOwned = new Set(manifest.target_owned_files ?? []);

    assert.ok(
      targetOwned.has(localEnvironment),
      `${localEnvironment} is deployment-owned and must be backed up and restored across full sync`,
    );
    assert.ok(!isExported(localEnvironment), `${localEnvironment} must never be exported from source`);
  });

  it('preserves target-owned file metadata across backup and restore', () => {
    const syncScript = readFileSync(SYNC_SCRIPT_PATH, 'utf8');
    const backupFunction = syncScript.match(/backup_target_owned_items\(\) \{[\s\S]*?\n\}/)?.[0] ?? '';
    const restoreFunction = syncScript.match(/restore_target_owned_items\(\) \{[\s\S]*?\n\}/)?.[0] ?? '';

    assert.match(backupFunction, /cp -pR /, 'target-owned directories must retain timestamps during backup');
    assert.match(backupFunction, /cp -p /, 'target-owned files must retain timestamps during backup');
    assert.match(restoreFunction, /cp -pR /, 'target-owned directories must retain timestamps during restore');
    assert.match(restoreFunction, /cp -p /, 'target-owned files must retain timestamps during restore');
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

  it('exports every project hook read by the public F296 authentication contract', () => {
    const contract = 'packages/api/test/f296-session-hook-auth.test.js';
    const source = readFileSync(resolve(ROOT, contract), 'utf8');
    const hookReferences = [...source.matchAll(/['"](\.\.\/\.\.\/\.\.\/\.claude\/hooks\/[^'"]+)['"]/g)].map((match) =>
      toRepoPath(resolveLocalImport(contract, match[1])),
    );

    assert.ok(hookReferences.length > 0, `${contract} must keep its real project-hook references`);
    for (const hook of hookReferences) {
      assert.ok(
        managedFiles.has(hook),
        `${hook} must be exported with ${contract}, otherwise test:public reads a missing runtime asset`,
      );
      assert.ok(!excluded.has(hook), `${hook} must not be excluded from the public filtered tree`);
    }
  });

  it('exports the Alpha runner closure exercised by the public F296 contracts', () => {
    const contracts = [
      'packages/api/test/f296-b4c-alpha-uat-runner.test.js',
      'packages/api/test/f296-b4c-alpha-uat-runner-guards.test.js',
    ];
    const runner = 'scripts/f296-alpha-uat.mjs';
    const contractHelper = 'scripts/lib/f296-alpha-uat-contract.mjs';
    const journeyHelper = 'scripts/lib/f296-alpha-uat-journeys.mjs';

    for (const contract of contracts) {
      const source = readFileSync(resolve(ROOT, contract), 'utf8');
      assert.match(
        source,
        /from '\.\.\/\.\.\/\.\.\/scripts\/f296-alpha-uat\.mjs'/,
        `${contract} must stay bound to the real Alpha runner`,
      );
    }

    assert.match(
      readFileSync(resolve(ROOT, runner), 'utf8'),
      /from '\.\/lib\/f296-alpha-uat-contract\.mjs'/,
      `${runner} must stay bound to its runtime contract`,
    );
    assert.match(
      readFileSync(resolve(ROOT, runner), 'utf8'),
      /from '\.\/lib\/f296-alpha-uat-journeys\.mjs'/,
      `${runner} must stay bound to its journey helpers`,
    );
    for (const path of [runner, contractHelper, journeyHelper]) {
      assert.ok(
        managedScripts.has(path),
        `${path} must be exported with the public F296 contracts, otherwise the public suite fails before UAT guards run`,
      );
      assert.ok(!excluded.has(path), `${path} must not be excluded from the public filtered tree`);
    }
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

  // F238 boundary closure (2026-08-31): the sanitizer used to prune the whole `site/` tree so the
  // public website could keep its deliberate "Clowder AI" origin story. That also disabled personal
  // info, home-path, and port scrubbing for every site file. The brand exemption now lives in
  // _sanitize-rules.pl (site-scoped, product-name only), so the export pass must sanitize site/
  // like any other managed root.
  it('sanitizes the exported site/ tree instead of pruning it', () => {
    const syncScript = readFileSync(resolve(ROOT, 'scripts/sync-to-opensource.sh'), 'utf8');
    assert.ok(
      !syncScript.includes('-path "$FILTERED_DIR/site" -prune'),
      'site/ must not be pruned out of the outbound sanitizer; the brand exemption belongs in _sanitize-rules.pl',
    );
  });

  // Stylesheets ship to the public repository like any other source file. They were on neither the
  // sanitizer extension list nor the security-scan include list, so internal role vocabulary
  // already reached clowder-ai through packages/web/src/app/*.css.
  //
  // Reviewer P1 (@codex-terra, PR #4153): keeping two hand-maintained lists is what produced the
  // gap in the first place — the sanitizer rewrote .cjs/.ps1/.py/.bat/.iss that the scan could not
  // see, and _sanitize-rules.pl has no secret-key redaction, so those types had no net at all.
  // Both passes must derive from one declared list.
  it('derives the sanitizer pass and the security scan from one text-type list', () => {
    const syncScript = readFileSync(SYNC_SCRIPT_PATH, 'utf8');
    const declared = readSanitizedTextExtensions(syncScript);
    for (const ext of ['md', 'ts', 'js', 'cjs', 'mjs', 'json', 'sh', 'ps1', 'py', 'bat', 'iss', 'html', 'svg', 'css']) {
      assert.ok(declared.includes(ext), `SANITIZED_TEXT_EXTENSIONS must declare ${ext} (got: ${declared.join(',')})`);
    }
    assert.match(
      syncScript,
      /for ext in "\$\{SANITIZED_TEXT_EXTENSIONS\[@\]\}"; do\n\s+if \[ \$\{#FIND_SANITIZED_EXPR\[@\]\} -gt 0 \]/,
      'the sanitizer find expression must be built from SANITIZED_TEXT_EXTENSIONS',
    );
    assert.match(
      syncScript,
      /SCAN_INCLUDES=""\nfor ext in "\$\{SANITIZED_TEXT_EXTENSIONS\[@\]\}"; do/,
      'SCAN_INCLUDES must be built from SANITIZED_TEXT_EXTENSIONS, not a second hand-kept list',
    );
    assert.doesNotMatch(
      syncScript,
      /^SCAN_INCLUDES='.*--include/m,
      'a literal SCAN_INCLUDES list reintroduces the drift this guard exists to prevent',
    );
  });

  // Behavioural, not textual: run the real blocking grep the way Step 4 runs it, over file types
  // the sanitizer exports but cannot redact. A secret in exported CommonJS used to be invisible.
  it('blocks a secret sentinel in every sanitized text type the scan must see', () => {
    const syncScript = readFileSync(SYNC_SCRIPT_PATH, 'utf8');
    const includes = readSanitizedTextExtensions(syncScript).map((ext) => `--include=*.${ext}`);
    const fixtureDir = mkdtempSync(join(tmpdir(), 'scan-includes-'));
    try {
      const sentinels = ['cjs', 'ps1', 'py', 'bat', 'iss', 'html', 'mjs', 'css'];
      for (const ext of sentinels) {
        writeFileSync(join(fixtureDir, `sentinel.${ext}`), 'const key = "sk-ant-fixture-not-a-real-key";\n', 'utf8');
      }
      const matched = execFileSync('grep', ['-rEl', readBlockingScanPattern(syncScript), fixtureDir, ...includes], {
        encoding: 'utf8',
      });
      for (const ext of sentinels) {
        assert.ok(matched.includes(`sentinel.${ext}`), `Step 4 scan filters must see *.${ext} (got: ${matched})`);
      }
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  // The canonical public site is the one at the export root. Anchoring the exemption to the root
  // the caller declares keeps a nested lookalike (packages/site/, docs/site/) from inheriting the
  // brand pass-through, and an undeclared root falls back to full sanitization.
  it('declares the export root when running the sanitizer', () => {
    const syncScript = readFileSync(SYNC_SCRIPT_PATH, 'utf8');
    assert.match(
      syncScript,
      /CAT_CAFE_SANITIZE_ROOT="\$FILTERED_DIR" xargs -0 perl -pi "\$SANITIZER"/,
      'the outbound sanitizer pass must declare its export root',
    );
  });

  // A guard nobody runs does not exist: both outbound boundary suites were unwired from every
  // pnpm entry point, so sanitizer rule changes shipped without a red light.
  it('runs the outbound boundary guards from a pnpm entry point', () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
    const guardScript = pkg.scripts['check:outbound-sanitizer'];
    assert.ok(guardScript, 'package.json must expose check:outbound-sanitizer');
    assert.ok(
      guardScript.includes('scripts/sanitize-rules-regression.test.mjs'),
      'the sanitizer regression suite must run in that entry point',
    );
    assert.ok(
      guardScript.includes('scripts/boundary-roundtrip.test.mjs'),
      'the boundary round-trip suite must run in that entry point',
    );
    assert.ok(
      pkg.scripts.check.includes('check:outbound-sanitizer'),
      'pnpm check must invoke check:outbound-sanitizer',
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
