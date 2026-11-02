import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { it } from 'node:test';
import {
  extractScriptRefs,
  isManagedPath,
  ROOT,
  readJsonFile,
  readYamlTopLevelList,
  readYamlTransformTargets,
  sanitizeFixture,
} from './context.mjs';
import { executePackageScriptsTransform } from './exported-scripts.mjs';

export function registerSyncTransformPart3() {
  it('blocks an unexported parent-relative API build helper until managed_scripts includes it', () => {
    const managedRoots = new Set(readYamlTopLevelList('sync-manifest.yaml', 'managed_roots'));
    const managedFiles = new Set(readYamlTopLevelList('sync-manifest.yaml', 'managed_files'));
    const managedScripts = new Set(readYamlTopLevelList('sync-manifest.yaml', 'managed_scripts'));
    const probe = 'scripts/future-public-closure-probe.mjs';
    const sourceScripts = readJsonFile('packages/api/package.json').scripts;
    sourceScripts['build:actual'] += ` && node ../../${probe}`;
    const exportedScripts = executePackageScriptsTransform(sourceScripts, 'API_PACKAGE_JSON_TRANSFORM_EOF');
    const refs = extractScriptRefs(exportedScripts.build, 'packages/api');
    const missing = () => refs.filter((ref) => !isManagedPath(ref, managedRoots, managedFiles, managedScripts));

    assert.deepEqual(missing(), [probe], 'the parent-relative dependency must not disappear from the guard');
    managedScripts.add(probe);
    assert.deepEqual(missing(), [], 'explicit export ownership closes the same dependency');
  });

  it('sync-manifest exports every scripts/* target referenced by exported package.json surfaces', () => {
    const managedRoots = new Set(readYamlTopLevelList('sync-manifest.yaml', 'managed_roots'));
    const managedFiles = new Set(readYamlTopLevelList('sync-manifest.yaml', 'managed_files'));
    const managedScripts = new Set(readYamlTopLevelList('sync-manifest.yaml', 'managed_scripts'));
    const packageJsonSurfaces = ['package.json'];

    for (const root of managedRoots) {
      const packageJsonPath = `${root}/package.json`;
      if (existsSync(resolve(ROOT, packageJsonPath))) {
        packageJsonSurfaces.push(packageJsonPath);
      }
    }

    const missing = [];
    for (const packageJsonPath of packageJsonSurfaces) {
      const pkg = readJsonFile(packageJsonPath);
      const transformMarker = {
        'package.json': 'PACKAGE_JSON_TRANSFORM_EOF',
        'packages/api/package.json': 'API_PACKAGE_JSON_TRANSFORM_EOF',
        'packages/shared/package.json': 'SHARED_PACKAGE_JSON_TRANSFORM_EOF',
        'packages/finance/package.json': 'SHARED_PACKAGE_JSON_TRANSFORM_EOF',
        'packages/mcp-server/package.json': 'MCP_PACKAGE_JSON_TRANSFORM_EOF',
      }[packageJsonPath];
      const scripts = transformMarker
        ? executePackageScriptsTransform(pkg.scripts ?? {}, transformMarker)
        : (pkg.scripts ?? {});
      const packageRoot = packageJsonPath === 'package.json' ? '' : packageJsonPath.slice(0, -'/package.json'.length);

      for (const [scriptName, command] of Object.entries(scripts)) {
        for (const exportPath of extractScriptRefs(command, packageRoot)) {
          if (!isManagedPath(exportPath, managedRoots, managedFiles, managedScripts)) {
            missing.push(`${packageJsonPath}:${scriptName} -> ${exportPath}`);
          }
        }
      }
    }

    assert.deepEqual(
      missing,
      [],
      `sync-manifest should export every scripts/* target referenced by exported package.json surfaces:\n${missing.join('\n')}`,
    );
  });

  it('exports the portable signal adapter referenced outside the managed Web package root', () => {
    const managedScripts = new Set(readYamlTopLevelList('sync-manifest.yaml', 'managed_scripts'));
    const webBuild = readJsonFile('packages/web/package.json').scripts?.build;

    assert.equal(
      webBuild,
      'node ../../scripts/run-preserving-signal-exit.mjs node ./node_modules/next/dist/bin/next build',
    );
    assert.ok(
      managedScripts.has('scripts/run-preserving-signal-exit.mjs'),
      'the exported Web build must not reference an adapter omitted from the public sync closure',
    );
  });

  it('sync-manifest exports public root script guard closure for stale-skill cleanup and brand checks', () => {
    const managedFiles = new Set(readYamlTopLevelList('sync-manifest.yaml', 'managed_files'));
    const managedScripts = new Set(readYamlTopLevelList('sync-manifest.yaml', 'managed_scripts'));
    const requiredScripts = [
      'scripts/check-biome-version.mjs',
      'scripts/clean-stale-skill-links.sh',
      'scripts/brand-dictionary-helper.mjs',
      'scripts/brand-dictionary-helper.test.mjs',
      'scripts/intake-from-opensource.sh',
      'scripts/intake-from-opensource.test.mjs',
    ];
    const requiredFiles = ['assets/brand-dictionary.yaml', '.githooks/pre-commit'];

    for (const scriptPath of requiredScripts) {
      assert.ok(
        managedScripts.has(scriptPath),
        `sync-manifest should export ${scriptPath} because public root package / test surfaces depend on it`,
      );
    }

    for (const filePath of requiredFiles) {
      assert.ok(
        managedFiles.has(filePath),
        `sync-manifest should export ${filePath} because public brand-guard tests depend on it`,
      );
    }
  });

  it('sync-manifest exports F180 user-level hook truth source', () => {
    const managedScripts = readYamlTopLevelList('sync-manifest.yaml', 'managed_scripts');
    const requiredHookScripts = [
      '.claude/hooks/user-level/session-start-recall.sh',
      '.claude/hooks/user-level/session-stop-check.sh',
    ];

    for (const scriptPath of requiredHookScripts) {
      assert.ok(
        managedScripts.includes(scriptPath),
        `sync-manifest should export ${scriptPath} so open-source users have hook templates`,
      );
    }
  });

  it('sync-manifest exports F203 native L0 runtime closure', () => {
    const managedFiles = readYamlTopLevelList('sync-manifest.yaml', 'managed_files');
    const managedRoots = readYamlTopLevelList('sync-manifest.yaml', 'managed_roots');
    const managedScripts = readYamlTopLevelList('sync-manifest.yaml', 'managed_scripts');

    assert.ok(
      managedFiles.includes('assets/system-prompts/system-prompt-l0.md'),
      'sync-manifest should export the F203 L0 template required by native prompt compilation',
    );
    assert.ok(
      managedRoots.includes('assets/prompt-templates'),
      'sync-manifest should export the F237 segmented L0 templates loaded by the native prompt compiler',
    );
    assert.ok(
      managedScripts.includes('scripts/compile-system-prompt-l0.mjs'),
      'sync-manifest should export the F203 L0 compiler required by carrier invocation',
    );
  });

  it('sync-manifest exports public harness eval fixtures used by test:public', () => {
    const managedFiles = readYamlTopLevelList('sync-manifest.yaml', 'managed_files');
    const managedRoots = readYamlTopLevelList('sync-manifest.yaml', 'managed_roots');

    // eval-domains/ is exported as a managed_root (whole directory), so the individual
    // domain registries (eval-a2a/eval-memory/eval-sop) + community-fixtures sync
    // automatically — they need NOT be listed in managed_files. This guard moved from
    // per-file enumeration to root-coverage after the recurring "F192 added a new domain
    // but forgot to update managed_files" sync-config debt (PR #1929).
    assert.ok(
      managedRoots.includes('docs/harness-feedback/eval-domains'),
      'eval-domains/ must be a managed_root so all domain registries + community-fixtures sync to the public repo',
    );

    // verdicts/ + bundles/ + F210 assets stay curated in managed_files (verdicts/bundles
    // may contain internal-only entries, so they are NOT blanket-exported as a root).
    const fixturePaths = [
      'docs/harness-feedback/verdicts/fixtures/2026-05-21-eval-a2a-contract-demo.md',
      'docs/harness-feedback/verdicts/2026-05-23-eval-a2a-live-verdict.md',
      'docs/harness-feedback/bundles/2026-05-23-eval-a2a-live-verdict/attribution.json',
      'docs/harness-feedback/bundles/2026-05-23-eval-a2a-live-verdict/provenance.json',
      'docs/harness-feedback/bundles/2026-05-23-eval-a2a-live-verdict/snapshot.json',
      'docs/features/assets/F210/agy-conversation-resume.txt',
      'docs/features/assets/F210/agy-print-timeout.txt',
      'docs/features/assets/F210/agy-real-home-no-default-model.txt',
      'docs/features/assets/F210/agy-real-home-print-success.txt',
    ];

    for (const fixturePath of fixturePaths) {
      assert.ok(
        managedFiles.includes(fixturePath),
        `sync-manifest should export ${fixturePath} because packages/api test:public loads it`,
      );
    }
  });

  it('sync-manifest marks the F203 native L0 template as a sanitized transform', () => {
    const transformTargets = readYamlTransformTargets('sync-manifest.yaml');

    assert.ok(
      transformTargets.includes('assets/system-prompts/system-prompt-l0.md'),
      'system-prompt-l0.md carries governance rules and must be explicitly tracked as a sanitize transform',
    );
    assert.ok(
      transformTargets.includes('assets/prompt-templates/l4-iron-laws.md'),
      'segmented L4 iron-laws template carries data-safety rules and must be explicitly tracked as a sanitize transform',
    );
  });

  it('public F203 native L0 template sanitization removes home-only runtime rules', () => {
    const sourceL0 = readFileSync(resolve(ROOT, 'assets/system-prompts/system-prompt-l0.md'), 'utf-8');
    const sanitized = sanitizeFixture('assets/system-prompts/system-prompt-l0.md', sourceL0);

    assert.doesNotMatch(sanitized, /Redis production Redis \(sacred\)/);
    assert.doesNotMatch(sanitized, /Redis production Redis (sacred)/);
    assert.doesNotMatch(sanitized, /\b6397\b|\b6398\b|\b6399\b/);
    assert.doesNotMatch(sanitized, /Clowder AI 的护城河是情感壁垒不是技术壁垒/);
  });

  it('public F237 segmented L4 template sanitization removes home-only runtime rules', () => {
    const sourceL4 = readFileSync(resolve(ROOT, 'assets/prompt-templates/l4-iron-laws.md'), 'utf-8');
    const sanitized = sanitizeFixture('assets/prompt-templates/l4-iron-laws.md', sourceL4);

    assert.match(sanitized, /\*\*Runtime data safety\*\*/);
    assert.match(sanitized, /\*\*Release acceptance channel\*\*/);
    assert.doesNotMatch(sanitized, /Redis production Redis \(sacred\)/);
    assert.doesNotMatch(sanitized, /Redis production Redis (sacred)/);
    assert.doesNotMatch(sanitized, /\b6397\b|\b6398\b|\b6399\b/);
    assert.doesNotMatch(sanitized, /co-creator/);
  });

  it('public docs and skill refs sanitize internal role, thread, and ops-cost markers', () => {
    const source = [
      'co-creator 原话',
      '孟加拉猫 / 暹罗猫 / 缅因猫',
      'thread_mq87iw5qmq93ygo6',
      'thread_eval_a2a',
      'cat_cafe_get_thread_context(<sub_thread_id>)',
      '$30-50 and $23',
      'shell examples may mention $1 and $2',
      '21 轮云端 review',
      'operator decision packet',
    ].join('\n');
    const sanitized = sanitizeFixture('docs/public-lessons.md', source);

    assert.doesNotMatch(sanitized, /co-creator|孟加拉猫|暹罗猫|缅因猫/);
    assert.doesNotMatch(sanitized, /\bthread_(?=[a-z0-9_]*[0-9])[a-z0-9_]{8,}\b/);
    assert.doesNotMatch(sanitized, /\$[1-9][0-9]+(?:-[1-9][0-9]+)?\b/);
    assert.doesNotMatch(sanitized, /云端 review|\bCVO\b/);
    assert.match(sanitized, /operator/);
    assert.match(sanitized, /Bengal/);
    assert.match(sanitized, /\[thread-id\]/);
    assert.match(sanitized, /operational cost/);
    assert.match(sanitized, /remote review/);
    assert.match(sanitized, /cat_cafe_get_thread_context\(<sub_thread_id>\)/);
    assert.match(sanitized, /\$1 and \$2/);
  });

  it('public skill shell scripts keep positional parameters while sanitizing prose docs', () => {
    const shell = sanitizeFixture(
      'cat-cafe-skills/hyperfocus-brake/state.sh',
      'local field="$1"\nlocal value="$2"\nprintf "%s=%s\\n" "$field" "$value"',
    );

    assert.match(shell, /local field="\$1"/);
    assert.match(shell, /local value="\$2"/);
  });

  it('public harness eval domain registries keep systemThreadId as a runtime string', () => {
    const yaml = sanitizeFixture(
      'docs/harness-feedback/eval-domains/eval-a2a.yaml',
      'domainId: eval:a2a\nsystemThreadId: thread_eval_a2a\n',
    );

    assert.match(yaml, /systemThreadId: thread_eval_a2a/);
    assert.doesNotMatch(yaml, /systemThreadId: \[thread-id\]/);
  });
}
