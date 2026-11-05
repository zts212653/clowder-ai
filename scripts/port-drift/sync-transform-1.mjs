import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { it } from 'node:test';
import { projectDeploymentProfiles, resolveDeploymentDefaults } from '../../packages/shared/src/deployment-defaults.ts';
import {
  loadWorkspacePackageRootsByName,
  parseYamlTopLevelList,
  ROOT,
  readEnvFile,
  readJsonFile,
  readSanitizedTextExtensions,
  readYamlTopLevelList,
  sanitizeFixture,
} from './context.mjs';

export function registerSyncTransformPart1() {
  it('_sanitize-rules.pl transforms 3002→3004 (API)', () => {
    const content = readFileSync(resolve(ROOT, 'scripts/_sanitize-rules.pl'), 'utf-8');
    assert.ok(
      content.includes('s#localhost:3004#localhost:3004#g'),
      'sanitize rules should transform localhost:3004 → localhost:3004',
    );
    assert.ok(
      content.includes('s#\\[::1\\]:3002#[::1]:3004#g'),
      'sanitize rules should transform IPv6 loopback [::1]:3004 → [::1]:3004',
    );
  });

  it('_sanitize-rules.pl transforms 3001→3003 (Frontend)', () => {
    const content = readFileSync(resolve(ROOT, 'scripts/_sanitize-rules.pl'), 'utf-8');
    assert.ok(
      content.includes('s#localhost:3003#localhost:3003#g'),
      'sanitize rules should transform localhost:3003 → localhost:3003',
    );
  });

  it('_sanitize-rules.pl keeps api-client port+1 tests internally consistent', () => {
    const content = readFileSync(resolve(ROOT, 'scripts/_sanitize-rules.pl'), 'utf-8');
    assert.ok(
      content.includes("s#port: '3001'#port: '3003'#g"),
      'api-client-resolve test input ports should transform alongside expected port+1 assertions',
    );
  });

  it('portable workspace staging uses sanitized frontend/API fallback ports after sync', () => {
    const stagingSource = sanitizeFixture(
      'packages/api/src/domains/cats/services/context/StagingContent.ts',
      readFileSync(resolve(ROOT, 'packages/api/src/domains/cats/services/context/StagingContent.ts'), 'utf-8'),
    );
    const stagingTest = sanitizeFixture(
      'packages/api/test/staging-content.test.js',
      readFileSync(resolve(ROOT, 'packages/api/test/staging-content.test.js'), 'utf-8'),
    );

    assert.doesNotMatch(stagingSource, /3001\/3002/);
    assert.match(stagingSource, /FRONTEND_PORT \?\? String\(deploymentDefaults.webPort\)/);
    assert.match(stagingSource, /API_SERVER_PORT \?\? String\(deploymentDefaults.apiPort\)/);
    assert.doesNotMatch(stagingTest, /3001\/3002/);
    assert.match(stagingTest, /defaultOut\.includes\('3003\/3004'\)/);
  });

  // The sanitizer pass and the Step 4 security scan are both generated from
  // SANITIZED_TEXT_EXTENSIONS, so membership in that list is what these guards assert.
  it('sync-to-opensource.sh runs sanitizer over CommonJS test files', () => {
    assert.ok(
      readSanitizedTextExtensions().includes('cjs'),
      'sync sanitizer should include .cjs files such as packages/web/test/next-config.test.cjs',
    );
  });

  it('sync-to-opensource.sh runs sanitizer over ES module utility files', () => {
    assert.ok(
      readSanitizedTextExtensions().includes('mjs'),
      'sync sanitizer should include .mjs files such as scripts/lib/platform-status.mjs',
    );
  });

  it('sync-to-opensource.sh runs sanitizer over desktop installer and launcher text files', () => {
    const declared = readSanitizedTextExtensions();
    for (const ext of ['ps1', 'py', 'bat', 'iss', 'html']) {
      assert.ok(
        declared.includes(ext),
        `sync sanitizer should include .${ext} files so public desktop release surfaces are sanitized`,
      );
    }
  });

  it('sync projects configuration data instead of mutating consumers', () => {
    const script = readFileSync(resolve(ROOT, 'scripts/sync-to-opensource.sh'), 'utf8');
    assert.match(script, /project-deployment-defaults\.mjs/);
    assert.doesNotMatch(script, /s\/API_PORT=\$\{API_SERVER_PORT:-3004/);
    const input = JSON.parse(readFileSync(resolve(ROOT, 'packages/shared/src/deployment-profiles.json'), 'utf8'));
    const projected = resolveDeploymentDefaults(projectDeploymentProfiles(input, 'opensource'));
    assert.equal(String(projected.apiPort), readEnvFile('.env.example.opensource').API_SERVER_PORT);
    assert.equal(String(projected.webPort), readEnvFile('.env.example.opensource').FRONTEND_PORT);
  });

  it('sync-to-opensource.sh keeps Windows Redis defaults unchanged', () => {
    const content = readFileSync(resolve(ROOT, 'scripts/sync-to-opensource.sh'), 'utf-8');
    assert.ok(!content.includes("'s/REDIS_PORT=6399/REDIS_PORT=6379/g'"));
    assert.ok(!content.includes('s/else { "6399" }/else { "6379" }/g'));
    assert.ok(!content.includes('s/\\$RedisPort = 6399/$RedisPort = 6379/g'));
    assert.ok(!content.includes('s/\\$redisPort = "6399"/$redisPort = "6379"/g'));
  });

  it('sync shell parsers preserve # inside YAML values but strip inline comments', () => {
    const outbound = readFileSync(resolve(ROOT, 'scripts/sync-to-opensource.sh'), 'utf-8');
    const hotfix = readFileSync(resolve(ROOT, 'scripts/sync-hotfix.sh'), 'utf-8');

    assert.match(outbound, /sub\(\/\[\[:space:\]\]#\.\*\/,\s*"",\s*line\)/);
    assert.match(hotfix, /sub\(\/\[\[:space:\]\]#\.\*\/,\s*"",\s*l\)/);
  });

  it('YAML parser scopes list membership to managed_scripts only', () => {
    const fixture = `
managed_scripts:
  - scripts/install.ps1 # keep this in sync
  - scripts/start-windows.ps1
  - scripts/foo#1.ps1
excluded:
  - scripts/install.ps1
`;

    assert.deepEqual(parseYamlTopLevelList(fixture, 'managed_scripts'), [
      'scripts/install.ps1',
      'scripts/start-windows.ps1',
      'scripts/foo#1.ps1',
    ]);
  });

  it('sync-manifest exports the Windows deploy scripts needed by F113', () => {
    const managedScripts = readYamlTopLevelList('sync-manifest.yaml', 'managed_scripts');
    const requiredScripts = [
      'scripts/install-auth-config.mjs',
      'scripts/install-windows-helpers.ps1',
      'scripts/install.ps1',
      'scripts/start-windows.ps1',
      'scripts/start.bat',
      'scripts/stop-windows.ps1',
      'scripts/windows-command-helpers.ps1',
      'scripts/windows-installer-ui.ps1',
    ];

    for (const scriptPath of requiredScripts) {
      assert.ok(
        managedScripts.includes(scriptPath),
        `sync-manifest should export ${scriptPath} instead of deleting it from clowder-ai`,
      );
    }
  });

  it('sync-manifest exports root package check script targets', () => {
    const managedRoots = readYamlTopLevelList('sync-manifest.yaml', 'managed_roots');
    const managedScripts = readYamlTopLevelList('sync-manifest.yaml', 'managed_scripts');
    const requiredScripts = [
      'scripts/check-followup-tails.mjs',
      'scripts/derive-worktree-ports.mjs',
      'scripts/derive-worktree-ports.test.mjs',
      'scripts/check-worktree-port-offset.mjs',
      'scripts/sop-definitions.mjs',
      'scripts/sop-definitions.test.mjs',
      'scripts/lib/sop-definition-codegen.mjs',
    ];

    assert.ok(
      managedRoots.includes('sop-definitions'),
      'sync-manifest should export sop-definitions because root package.json check:sop-definitions reads it',
    );

    for (const scriptPath of requiredScripts) {
      assert.ok(
        managedScripts.includes(scriptPath),
        `sync-manifest should export ${scriptPath} because root package.json references it`,
      );
    }
  });

  it('sync-manifest exports every script an exported skill runs (node scripts/*.mjs)', () => {
    // Dynamic closure: exported skills (cat-cafe-skills/, a managed_root) invoke helper
    // scripts via `node scripts/<name>.mjs` inside SKILL.md. Any such script missing from
    // managed_scripts makes the open-source skill mirror point at a nonexistent file.
    // The hard-coded requiredScripts lists above cannot catch newly-referenced scripts.
    // cloud P2-1 (cat-cafe#2846) surfaced classify-merge-outcome.mjs; this guard also
    // closed the pre-existing check-hotfix-pattern.mjs / check-fallback-layers.mjs gaps.
    const managedScripts = new Set(readYamlTopLevelList('sync-manifest.yaml', 'managed_scripts'));
    const skillFiles = execFileSync('find', ['cat-cafe-skills', '-name', 'SKILL.md'], {
      cwd: ROOT,
      encoding: 'utf-8',
    })
      .trim()
      .split('\n')
      .filter(Boolean);
    const re = /node\s+(scripts\/[\w/-]+\.mjs)\b/g;
    const missing = [];
    for (const rel of skillFiles) {
      const txt = readFileSync(resolve(ROOT, rel), 'utf-8');
      for (const m of txt.matchAll(re)) {
        if (!managedScripts.has(m[1])) {
          missing.push(`${m[1]} (referenced by ${rel})`);
        }
      }
    }
    assert.deepEqual(
      missing,
      [],
      `Exported skills reference scripts missing from sync-manifest managed_scripts:\n  ${missing.join('\n  ')}`,
    );
  });

  it('sync-manifest exports workspace dependency closure for managed package roots', () => {
    const managedRoots = new Set(readYamlTopLevelList('sync-manifest.yaml', 'managed_roots'));
    const workspaceRootsByName = loadWorkspacePackageRootsByName();

    for (const root of managedRoots) {
      if (!root.startsWith('packages/')) continue;

      const packageJsonPath = `${root}/package.json`;
      if (!existsSync(resolve(ROOT, packageJsonPath))) continue;

      const packageJson = readJsonFile(packageJsonPath);
      const dependencyGroups = [
        packageJson.dependencies ?? {},
        packageJson.devDependencies ?? {},
        packageJson.peerDependencies ?? {},
        packageJson.optionalDependencies ?? {},
      ];

      for (const dependencies of dependencyGroups) {
        for (const [dependencyName, dependencySpec] of Object.entries(dependencies)) {
          if (typeof dependencySpec !== 'string' || !dependencySpec.startsWith('workspace:')) continue;

          const dependencyRoot = workspaceRootsByName.get(dependencyName);
          assert.ok(
            dependencyRoot,
            `${root} depends on workspace package ${dependencyName}, but packages/* does not contain it`,
          );
          assert.ok(
            managedRoots.has(dependencyRoot),
            `sync-manifest should export ${dependencyRoot} because managed root ${root} depends on ${dependencyName}`,
          );
        }
      }
    }
  });

  it('sync-manifest exports public root package helper script targets', () => {
    const managedScripts = readYamlTopLevelList('sync-manifest.yaml', 'managed_scripts');
    const requiredScripts = [
      'scripts/cleanup-stale-dev-processes.mjs',
      'scripts/video-forge/new-project.mjs',
      'scripts/check-skill-first-party-surfaces.test.mjs',
      'scripts/check-skill-first-party-surfaces.mjs',
      'scripts/check-skill-first-party-surfaces.allowlist.json',
    ];

    for (const scriptPath of requiredScripts) {
      assert.ok(
        managedScripts.includes(scriptPath),
        `sync-manifest should export ${scriptPath} because public package.json exposes it`,
      );
    }
  });
}
