/**
 * Port drift guard — ensures .env.example.opensource ports stay consistent
 * with sync-to-opensource.sh transforms.
 *
 * Root cause of clowder-ai#87 / #55 / #56: the .env.example.opensource had
 * API_SERVER_PORT and FRONTEND_PORT swapped relative to the code defaults
 * that sync-to-opensource.sh produces. This test prevents that from recurring.
 *
 * Convention (set by _sanitize-rules.pl + sync-to-opensource.sh):
 *   Home:        API=3002, Frontend=3001
 *   Open-source: API=3004, Frontend=3003
 *   Redis:       stays 6399 in both repos
 *   (API = Frontend + 1 in both environments)
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const ROOT = resolve(process.cwd());

// Detect repo context early — used by multiple describe blocks.
// Home repo has sync-to-opensource.sh; open-source repo does not.
const isHomeRepo = existsSync(resolve(ROOT, 'scripts/sync-to-opensource.sh'));
const hasEnvExampleOpensource = existsSync(resolve(ROOT, '.env.example.opensource'));

function readEnvFile(relPath) {
  const content = readFileSync(resolve(ROOT, relPath), 'utf-8');
  const vars = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    vars[key] = val;
  }
  return vars;
}

function readScriptFallback(relPath, varName) {
  const content = readFileSync(resolve(ROOT, relPath), 'utf-8');
  // Match pattern: VAR=${ENV_NAME:-DEFAULT}
  const re = new RegExp(`${varName}=\\$\\{\\w+:-([^}]+)\\}`);
  const m = content.match(re);
  return m ? m[1] : null;
}

function readTsFallback(relPath, pattern) {
  const content = readFileSync(resolve(ROOT, relPath), 'utf-8');
  const m = content.match(pattern);
  return m ? m[1] : null;
}

function readPowerShellFallback(relPath, pattern) {
  const content = readFileSync(resolve(ROOT, relPath), 'utf-8');
  const m = content.match(pattern);
  return m ? m[1] : null;
}

function normalizeYamlListItem(line) {
  return line
    .replace(/\s+#.*$/, '')
    .replaceAll('"', '')
    .trim();
}

function readYamlTopLevelKey(line) {
  return line.match(/^([A-Za-z0-9_-]+):\s*$/)?.[1] ?? null;
}

function parseYamlTopLevelList(content, sectionName) {
  const lines = content.split('\n');
  const values = [];
  let inSection = false;

  for (const line of lines) {
    const topLevelKey = readYamlTopLevelKey(line);
    if (topLevelKey === sectionName) {
      inSection = true;
      continue;
    }
    if (topLevelKey && inSection) {
      break;
    }

    if (!inSection) continue;

    const listItem = line.match(/^ {2}- (.+)$/)?.[1];
    if (listItem) {
      const normalized = normalizeYamlListItem(listItem);
      if (normalized.length > 0) {
        values.push(normalized);
      }
    }
  }

  return values;
}

function readYamlTopLevelList(relPath, sectionName) {
  return parseYamlTopLevelList(readFileSync(resolve(ROOT, relPath), 'utf-8'), sectionName);
}

function readSyncScript() {
  return readFileSync(resolve(ROOT, 'scripts/sync-to-opensource.sh'), 'utf-8');
}

function readFunctionBody(content, functionName) {
  const start = content.indexOf(`${functionName}() {`);
  assert.notEqual(start, -1, `expected to find function ${functionName} in sync-to-opensource.sh`);

  const end = content.indexOf('\n}\n', start);
  assert.notEqual(end, -1, `expected to find the end of function ${functionName} in sync-to-opensource.sh`);

  return content.slice(start, end);
}

describe(
  '.env.example.opensource port consistency',
  { skip: !hasEnvExampleOpensource && '.env.example.opensource not present (open-source repo uses .env.example)' },
  () => {
    const env = readEnvFile('.env.example.opensource');

    it('API_SERVER_PORT matches sync convention (3004)', () => {
      assert.equal(
        env.API_SERVER_PORT,
        '3004',
        `API_SERVER_PORT should be 3004 (open-source convention), got ${env.API_SERVER_PORT}`,
      );
    });

    it('FRONTEND_PORT matches sync convention (3003)', () => {
      assert.equal(
        env.FRONTEND_PORT,
        '3003',
        `FRONTEND_PORT should be 3003 (open-source convention), got ${env.FRONTEND_PORT}`,
      );
    });

    it('NEXT_PUBLIC_API_URL uses API port (3004)', () => {
      assert.equal(
        env.NEXT_PUBLIC_API_URL,
        'http://localhost:3004',
        `NEXT_PUBLIC_API_URL should point to API port 3004, got ${env.NEXT_PUBLIC_API_URL}`,
      );
    });

    it('REDIS_PORT stays on 6399', () => {
      assert.equal(env.REDIS_PORT, '6399', `REDIS_PORT should stay 6399, got ${env.REDIS_PORT}`);
    });

    it('REDIS_URL stays on localhost:6399', () => {
      assert.equal(
        env.REDIS_URL,
        'redis://localhost:6399',
        `REDIS_URL should stay on localhost:6399, got ${env.REDIS_URL}`,
      );
    });

    it('.env.example.opensource comment header documents correct ports', () => {
      const content = readFileSync(resolve(ROOT, '.env.example.opensource'), 'utf-8');
      // The comment should say Frontend=3003, API=3004
      assert.ok(
        content.includes('3004') && content.includes('3003'),
        'Comment header should mention both 3003 and 3004',
      );
    });
  },
);

// In the home repo (cat-cafe), code defaults are API=3002 / Frontend=3001.
// In the open-source repo (clowder-ai), sync transforms them to Frontend=3003 / API=3004.
const expectedApiPort = isHomeRepo ? '3002' : '3004';
const expectedFrontendPort = isHomeRepo ? '3001' : '3003';
const repoLabel = isHomeRepo ? 'home' : 'open-source';

describe(`Code-side port defaults are internally consistent (${repoLabel}: API=${expectedApiPort}, Frontend=${expectedFrontendPort})`, () => {
  it(`start-dev.sh API fallback is ${expectedApiPort}`, () => {
    const fallback = readScriptFallback('scripts/start-dev.sh', 'API_PORT');
    assert.equal(
      fallback,
      expectedApiPort,
      `start-dev.sh API_PORT fallback should be ${expectedApiPort}, got ${fallback}`,
    );
  });

  it(`start-dev.sh Frontend fallback is ${expectedFrontendPort}`, () => {
    const fallback = readScriptFallback('scripts/start-dev.sh', 'WEB_PORT');
    assert.equal(
      fallback,
      expectedFrontendPort,
      `start-dev.sh WEB_PORT fallback should be ${expectedFrontendPort}, got ${fallback}`,
    );
  });

  it(`index.ts API port fallback is ${expectedApiPort}`, () => {
    const fallback = readTsFallback('packages/api/src/index.ts', /API_SERVER_PORT\s*\?\?\s*'(\d+)'/);
    assert.equal(fallback, expectedApiPort, `index.ts API fallback should be ${expectedApiPort}, got ${fallback}`);
  });

  it(`env-registry.ts API_SERVER_PORT defaultValue is ${expectedApiPort}`, () => {
    const fallback = readTsFallback(
      'packages/api/src/config/env-registry.ts',
      /name:\s*'API_SERVER_PORT',\s*defaultValue:\s*'(\d+)'/,
    );
    assert.equal(
      fallback,
      expectedApiPort,
      `env-registry API_SERVER_PORT default should be ${expectedApiPort}, got ${fallback}`,
    );
  });

  it(`ConfigRegistry.ts API port fallback is ${expectedApiPort}`, () => {
    const fallback = readTsFallback('packages/api/src/config/ConfigRegistry.ts', /API_SERVER_PORT\s*\?\?\s*'(\d+)'/);
    assert.equal(
      fallback,
      expectedApiPort,
      `ConfigRegistry API fallback should be ${expectedApiPort}, got ${fallback}`,
    );
  });

  it(`frontend-origin.ts DEFAULT_FRONTEND_BASE_URL uses port ${expectedFrontendPort}`, () => {
    const fallback = readTsFallback(
      'packages/api/src/config/frontend-origin.ts',
      /DEFAULT_FRONTEND_BASE_URL\s*=\s*'http:\/\/localhost:(\d+)'/,
    );
    assert.equal(
      fallback,
      expectedFrontendPort,
      `frontend-origin DEFAULT_FRONTEND_BASE_URL should use ${expectedFrontendPort}, got ${fallback}`,
    );
  });

  it(`setup.sh API_SERVER_PORT is ${expectedApiPort}`, () => {
    const content = readFileSync(resolve(ROOT, 'scripts/setup.sh'), 'utf-8');
    assert.ok(
      content.includes(`API_SERVER_PORT=${expectedApiPort}`),
      `setup.sh should set API_SERVER_PORT=${expectedApiPort}`,
    );
  });

  it(`setup.sh FRONTEND_PORT is ${expectedFrontendPort}`, () => {
    const content = readFileSync(resolve(ROOT, 'scripts/setup.sh'), 'utf-8');
    assert.ok(
      content.includes(`FRONTEND_PORT=${expectedFrontendPort}`),
      `setup.sh should set FRONTEND_PORT=${expectedFrontendPort}`,
    );
  });

  it(`setup.sh NEXT_PUBLIC_API_URL uses port ${expectedApiPort}`, () => {
    const content = readFileSync(resolve(ROOT, 'scripts/setup.sh'), 'utf-8');
    assert.ok(
      content.includes(`NEXT_PUBLIC_API_URL=http://localhost:${expectedApiPort}`),
      `setup.sh should set NEXT_PUBLIC_API_URL to localhost:${expectedApiPort}`,
    );
  });

  it(`runtime-worktree.sh API port fallback is ${expectedApiPort}`, () => {
    const fallback = readTsFallback('scripts/runtime-worktree.sh', /API_SERVER_PORT:-(\d+)/);
    assert.equal(
      fallback,
      expectedApiPort,
      `runtime-worktree.sh API port fallback should be ${expectedApiPort}, got ${fallback}`,
    );
  });

  it(`AgentRouter.ts API port fallback is ${expectedApiPort}`, () => {
    const fallback = readTsFallback(
      'packages/api/src/domains/cats/services/agents/routing/AgentRouter.ts',
      /API_SERVER_PORT\s*\?\?\s*'(\d+)'/,
    );
    assert.equal(
      fallback,
      expectedApiPort,
      `AgentRouter.ts API fallback should be ${expectedApiPort}, got ${fallback}`,
    );
  });

  it(`start-windows.ps1 API fallback is ${expectedApiPort}`, () => {
    const fallback = readPowerShellFallback(
      'scripts/start-windows.ps1',
      /\$ApiPort = if \(\$env:API_SERVER_PORT\) \{ \$env:API_SERVER_PORT \} else \{ "(\d+)" \}/,
    );
    assert.equal(
      fallback,
      expectedApiPort,
      `start-windows.ps1 API fallback should be ${expectedApiPort}, got ${fallback}`,
    );
  });

  it(`start-windows.ps1 Frontend fallback is ${expectedFrontendPort}`, () => {
    const fallback = readPowerShellFallback(
      'scripts/start-windows.ps1',
      /\$WebPort = if \(\$env:FRONTEND_PORT\) \{ \$env:FRONTEND_PORT \} else \{ "(\d+)" \}/,
    );
    assert.equal(
      fallback,
      expectedFrontendPort,
      `start-windows.ps1 Frontend fallback should be ${expectedFrontendPort}, got ${fallback}`,
    );
  });

  it('start-windows.ps1 Redis fallback uses repo-local default', () => {
    const fallback = readPowerShellFallback(
      'scripts/start-windows.ps1',
      /\$RedisPort = if \(\$env:REDIS_PORT\) \{ \$env:REDIS_PORT \} else \{ "(\d+)" \}/,
    );
    assert.equal(fallback, '6399');
  });

  it(`stop-windows.ps1 API fallback is ${expectedApiPort}`, () => {
    const fallback = readPowerShellFallback('scripts/stop-windows.ps1', /\$ApiPort = (\d+)/);
    assert.equal(
      fallback,
      expectedApiPort,
      `stop-windows.ps1 API fallback should be ${expectedApiPort}, got ${fallback}`,
    );
  });

  it(`stop-windows.ps1 Frontend fallback is ${expectedFrontendPort}`, () => {
    const fallback = readPowerShellFallback('scripts/stop-windows.ps1', /\$WebPort = (\d+)/);
    assert.equal(
      fallback,
      expectedFrontendPort,
      `stop-windows.ps1 Frontend fallback should be ${expectedFrontendPort}, got ${fallback}`,
    );
  });

  it('stop-windows.ps1 Redis fallback uses repo-local default', () => {
    const fallback = readPowerShellFallback('scripts/stop-windows.ps1', /\$RedisPort = (\d+)/);
    assert.equal(fallback, '6399');
  });

  it(`install.ps1 minimal .env fallback uses API ${expectedApiPort} and Frontend ${expectedFrontendPort}`, () => {
    const content = readFileSync(resolve(ROOT, 'scripts/install.ps1'), 'utf-8');
    assert.ok(
      content.includes(`FRONTEND_PORT=${expectedFrontendPort}`),
      `install.ps1 minimal .env should set FRONTEND_PORT=${expectedFrontendPort}`,
    );
    assert.ok(
      content.includes(`API_SERVER_PORT=${expectedApiPort}`),
      `install.ps1 minimal .env should set API_SERVER_PORT=${expectedApiPort}`,
    );
    assert.ok(
      content.includes(`NEXT_PUBLIC_API_URL=http://localhost:${expectedApiPort}`),
      `install.ps1 minimal .env should set NEXT_PUBLIC_API_URL to localhost:${expectedApiPort}`,
    );
  });

  it('install.ps1 Redis fallback uses repo-local default', () => {
    const content = readFileSync(resolve(ROOT, 'scripts/install.ps1'), 'utf-8');
    assert.ok(content.includes('REDIS_PORT=6399'));
  });

  it(`install.ps1 post-install open URL fallback uses frontend port ${expectedFrontendPort}`, () => {
    const fallback = readPowerShellFallback(
      'scripts/install.ps1',
      /if \(-not \$frontendPort\) \{ \$frontendPort = "(\d+)" \}/,
    );
    assert.equal(
      fallback,
      expectedFrontendPort,
      `install.ps1 final frontend fallback should be ${expectedFrontendPort}, got ${fallback}`,
    );
  });
});

describe(
  'Sync transform rules match convention',
  { skip: !isHomeRepo && 'sync infrastructure not present (open-source repo)' },
  () => {
    it('_sanitize-rules.pl transforms 3002→3004 (API)', () => {
      const content = readFileSync(resolve(ROOT, 'scripts/_sanitize-rules.pl'), 'utf-8');
      assert.ok(
        content.includes('s#localhost:3002#localhost:3004#g'),
        'sanitize rules should transform localhost:3002 → localhost:3004',
      );
    });

    it('_sanitize-rules.pl transforms 3001→3003 (Frontend)', () => {
      const content = readFileSync(resolve(ROOT, 'scripts/_sanitize-rules.pl'), 'utf-8');
      assert.ok(
        content.includes('s#localhost:3001#localhost:3003#g'),
        'sanitize rules should transform localhost:3001 → localhost:3003',
      );
    });

    it('sync-to-opensource.sh transforms start-dev.sh API fallback to 3004', () => {
      const content = readFileSync(resolve(ROOT, 'scripts/sync-to-opensource.sh'), 'utf-8');
      const expected = "'s/API_PORT=$" + '{API_SERVER_PORT:-3002}/API_PORT=$' + "{API_SERVER_PORT:-3004}/g'";
      assert.ok(content.includes(expected), 'sync script should transform start-dev.sh API fallback 3002→3004');
    });

    it('sync-to-opensource.sh transforms start-dev.sh Frontend fallback to 3003', () => {
      const content = readFileSync(resolve(ROOT, 'scripts/sync-to-opensource.sh'), 'utf-8');
      const expected = "'s/WEB_PORT=$" + '{FRONTEND_PORT:-3001}/WEB_PORT=$' + "{FRONTEND_PORT:-3003}/g'";
      assert.ok(content.includes(expected), 'sync script should transform start-dev.sh Frontend fallback 3001→3003');
    });

    it('sync-to-opensource.sh transforms setup.sh API port to 3004', () => {
      const content = readFileSync(resolve(ROOT, 'scripts/sync-to-opensource.sh'), 'utf-8');
      assert.ok(
        content.includes("'s/API_SERVER_PORT=3002/API_SERVER_PORT=3004/g'"),
        'sync script should transform setup.sh API_SERVER_PORT 3002→3004',
      );
    });

    it('sync-to-opensource.sh transforms setup.sh Frontend port to 3003', () => {
      const content = readFileSync(resolve(ROOT, 'scripts/sync-to-opensource.sh'), 'utf-8');
      assert.ok(
        content.includes("'s/FRONTEND_PORT=3001/FRONTEND_PORT=3003/g'"),
        'sync script should transform setup.sh FRONTEND_PORT 3001→3003',
      );
    });

    it('sync-to-opensource.sh transforms runtime-worktree.sh API port to 3004', () => {
      const content = readFileSync(resolve(ROOT, 'scripts/sync-to-opensource.sh'), 'utf-8');
      assert.ok(
        content.includes("'s/API_SERVER_PORT:-3002/API_SERVER_PORT:-3004/g'"),
        'sync script should transform runtime-worktree.sh API port 3002→3004',
      );
    });

    it('sync-to-opensource.sh transforms install.ps1 to public defaults', () => {
      const content = readFileSync(resolve(ROOT, 'scripts/sync-to-opensource.sh'), 'utf-8');
      assert.ok(content.includes("'s/FRONTEND_PORT=3001/FRONTEND_PORT=3003/g'"));
      assert.ok(content.includes("'s/API_SERVER_PORT=3002/API_SERVER_PORT=3004/g'"));
      assert.ok(content.includes('$frontendPort = "3003"'));
    });

    it('sync-to-opensource.sh transforms start-windows.ps1 API/frontend defaults', () => {
      const content = readFileSync(resolve(ROOT, 'scripts/sync-to-opensource.sh'), 'utf-8');
      assert.ok(content.includes('s/else { "3002" }/else { "3004" }/g'));
      assert.ok(content.includes('s/else { "3001" }/else { "3003" }/g'));
    });

    it('sync-to-opensource.sh transforms stop-windows.ps1 API/frontend defaults', () => {
      const content = readFileSync(resolve(ROOT, 'scripts/sync-to-opensource.sh'), 'utf-8');
      assert.ok(content.includes('s/\\$ApiPort = 3002/$ApiPort = 3004/g'));
      assert.ok(content.includes('s/\\$WebPort = 3001/$WebPort = 3003/g'));
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

    it('sync-to-opensource.sh transforms AgentRouter.ts API port to 3004', () => {
      const content = readFileSync(resolve(ROOT, 'scripts/sync-to-opensource.sh'), 'utf-8');
      assert.ok(
        content.includes("process.env.API_SERVER_PORT ?? '3004'"),
        'sync script should transform AgentRouter.ts API port 3002→3004',
      );
    });

    it('sync-to-opensource.sh leaves sync tag publication to scripts/publish-sync-tag.sh', () => {
      const content = readFileSync(resolve(ROOT, 'scripts/sync-to-opensource.sh'), 'utf-8');
      const publishScript = readFileSync(resolve(ROOT, 'scripts/publish-sync-tag.sh'), 'utf-8');
      assert.doesNotMatch(
        content,
        /git -C "\$SOURCE_DIR" tag "\$SYNC_TAG"/,
        'sync-to-opensource should not create a sync tag before the target sync lands',
      );
      assert.doesNotMatch(
        content,
        /git -C "\$SOURCE_DIR" push origin "refs\/tags\/\$SYNC_TAG"/,
        'sync-to-opensource should not publish a sync tag before the target sync is visible upstream',
      );
      assert.match(
        content,
        /if \[ "\$DRY_RUN" = false \] && \[ "\$VALIDATE" = false \]; then[\s\S]*After merge: \$PUBLISH_HANDOFF_CMD/,
        'sync-to-opensource should only print the post-merge publish handoff for real sync runs',
      );
      assert.match(
        content,
        /PUBLISH_HANDOFF_CMD="bash scripts\/publish-sync-tag\.sh --source-sha=\$\(git -C "\$SOURCE_DIR" rev-parse HEAD\) --push"/,
        'sync-to-opensource should print the post-merge publish-sync-tag.sh handoff command',
      );
      assert.match(
        content,
        /PUBLISH_HANDOFF_CMD="CLOWDER_AI_DIR=\$\(printf '%q' "\$TARGET_DIR"\) \$PUBLISH_HANDOFF_CMD"/,
        'sync-to-opensource should preserve a custom CLOWDER_AI_DIR in the publish handoff',
      );
      assert.match(
        publishScript,
        /git -C "\$repo" tag "\$SYNC_TAG" "\$sha"/,
        'post-merge lane should contain a real tag creation command',
      );
      assert.match(
        publishScript,
        /TARGET_SHA=\$\(resolve_latest_landed_sync_commit "\$TARGET_MAIN_REF"\)/,
        'post-merge lane should auto-detect the latest landed target sync commit when --target-sha is omitted',
      );
      assert.match(
        publishScript,
        /ensure_tag_points_to "\$SOURCE_DIR" "cat-cafe" "\$SOURCE_SHA"/,
        'post-merge lane should have a real source-tag publication command',
      );
      assert.match(
        publishScript,
        /ensure_tag_points_to "\$TARGET_DIR" "clowder-ai" "\$TARGET_SHA"/,
        'post-merge lane should advance the matching clowder-ai tag too',
      );
    });

    it('sync-to-opensource.sh supports release-intended source snapshot tags and provenance mapping', () => {
      const content = readFileSync(resolve(ROOT, 'scripts/sync-to-opensource.sh'), 'utf-8');
      assert.match(
        content,
        /--release-tag=\*\) RELEASE_TAG="\$\{arg#--release-tag=\}" ;;/,
        'sync-to-opensource should parse --release-tag',
      );
      assert.match(
        content,
        /SOURCE_SNAPSHOT_TAG="\$\(derive_source_snapshot_tag "\$RELEASE_TAG"\)"/,
        'sync-to-opensource should derive a source snapshot tag from the release tag',
      );
      assert.match(
        content,
        /"release_tag": \$RELEASE_TAG_JSON,/,
        'sync-to-opensource should persist release_tag in .sync-provenance.json',
      );
      assert.match(
        content,
        /"source_snapshot_tag": \$SOURCE_SNAPSHOT_TAG_JSON,/,
        'sync-to-opensource should persist source_snapshot_tag in .sync-provenance.json',
      );
      assert.match(
        content,
        /ensure_source_snapshot_tag "\$SOURCE_SNAPSHOT_TAG" "\$SOURCE_SHA" "\$RELEASE_TAG"/,
        'sync-to-opensource should auto-create the source snapshot tag before touching the real target',
      );
      assert.match(
        content,
        /git -C "\$SOURCE_DIR" tag -a "\$tag" "\$sha" -m "source snapshot for clowder-ai \$release_tag"/,
        'release-intended sync should create an annotated source snapshot tag',
      );
      assert.match(
        content,
        /git -C "\$SOURCE_DIR" push origin "refs\/tags\/\$tag"/,
        'release-intended sync should publish the source snapshot tag to origin',
      );
      assert.match(
        content,
        /require_release_source_commit_on_main\(\) \{/,
        'release-intended sync should define a guard ensuring the source snapshot commit is on origin\\/main',
      );
      assert.match(
        content,
        /require_release_source_commit_on_main "\$SOURCE_SHA"/,
        'release-intended sync should verify the source commit is reachable from origin\\/main before syncing',
      );
    });

    it('sync-hotfix.sh selects the latest sync baseline by mirrored target tag commit time', () => {
      const hotfix = readFileSync(resolve(ROOT, 'scripts/sync-hotfix.sh'), 'utf-8');
      assert.match(
        hotfix,
        /git -C "\$SOURCE_DIR" fetch --quiet --force --prune --prune-tags origin[\s\\]+"\+refs\/tags\/sync\/\*:refs\/tags\/sync\/\*"/,
        'hotfix lane should refresh cat-cafe sync tags from origin before auto-selecting the baseline',
      );
      assert.match(
        hotfix,
        /git -C "\$TARGET_DIR" fetch --quiet origin main/,
        'hotfix lane should refresh clowder-ai origin\\/main before auto-selecting the baseline',
      );
      assert.match(
        hotfix,
        /TARGET_SYNC_TAG_REFS="refs\/cat-cafe-hotfix-sync-tags"/,
        'hotfix lane should mirror clowder-ai sync tags into a dedicated local ref namespace',
      );
      assert.doesNotMatch(
        hotfix,
        /git -C "\$TARGET_DIR" fetch --quiet --force origin[\s\\]+"\+refs\/tags\/sync\/\*:refs\/tags\/sync\/\*"/,
        'hotfix lane should not mirror sync tags into clowder-ai local tag refs during baseline selection',
      );
      assert.match(
        hotfix,
        /git -C "\$TARGET_DIR" fetch --quiet --force --prune origin[\s\\]+"\+refs\/tags\/sync\/\*:\$TARGET_SYNC_TAG_REFS\/\*"/,
        'hotfix lane should force-refresh the mirrored clowder-ai sync tag namespace',
      );
      assert.match(
        hotfix,
        /merge-base --is-ancestor[\s\\]+"\$TARGET_SYNC_TAG_REFS\/\$tag\^\{commit\}" refs\/remotes\/origin\/main/,
        'hotfix lane should ignore mirrored target sync tags that are no longer reachable from clowder-ai origin/main',
      );
      assert.match(
        hotfix,
        /show -s --format=%ct "\$TARGET_SYNC_TAG_REFS\/\$tag\^\{commit\}"/,
        'hotfix lane should compare mirrored clowder-ai tag commit times when choosing the latest sync baseline',
      );
      assert.match(
        hotfix,
        /rev-parse --verify "\$TARGET_SYNC_TAG_REFS\/\$SYNC_TAG\^\{commit\}"/,
        'hotfix lane should require explicit --tag baselines to exist in the mirrored clowder-ai origin tag namespace',
      );
      assert.match(
        hotfix,
        /merge-base --is-ancestor[\s\\]+"\$TARGET_SYNC_TAG_REFS\/\$SYNC_TAG\^\{commit\}" refs\/remotes\/origin\/main/,
        'hotfix lane should reject explicit --tag baselines that are no longer on clowder-ai origin/main',
      );
      assert.doesNotMatch(
        hotfix,
        /tag -l 'sync\/\*' --sort=-version:refname \| head -1/,
        'hotfix lane should not rely on tag-name sort alone for latest-sync selection',
      );
    });
  },
);

describe(
  'Sync validation enforces static quality gates',
  { skip: !isHomeRepo && 'sync infrastructure not present (open-source repo)' },
  () => {
    it('validate mode runs the source-owned public gate on a temp target', () => {
      const content = readSyncScript();
      const staticGateFn = readFunctionBody(content, 'run_static_quality_gates');
      const validateBlock = content.match(
        /Validate temp target \(source-owned public gate\)[\s\S]*?\[VALIDATE\] Export at:/,
      )?.[0];

      assert.match(
        staticGateFn,
        /pnpm check:fix[\s\S]*pnpm check 2>&1[\s\S]*pnpm lint 2>&1/,
        'run_static_quality_gates should run pnpm check:fix → pnpm check → pnpm lint in order',
      );
      assert.ok(validateBlock, 'expected to find the validate block in sync-to-opensource.sh');
      assert.ok(
        validateBlock.includes('prepare_validation_target'),
        'validate mode should materialize a temp target before running the public gate',
      );
      assert.ok(
        validateBlock.includes('sync_filtered_into_target "$VALIDATION_TARGET_DIR"'),
        'validate mode should apply the exact exported payload to the temp target',
      );
      assert.ok(
        validateBlock.includes('run_target_public_gate "$VALIDATION_TARGET_DIR"'),
        'validate mode should reuse the same target/public gate as a real full sync',
      );
    });

    it('full sync runs the temp target public gate before touching the real target', () => {
      const content = readSyncScript();
      const tempGateIndex = content.indexOf('Source-owned public gate (temp target)...');
      const realSyncIndex = content.indexOf('sync_filtered_into_target "$TARGET_DIR"');
      const step6SummaryIndex = content.indexOf('[Step 6/6] Sync committed after source-owned public gate passed');

      assert.notEqual(tempGateIndex, -1, 'expected to find the temp target public gate block');
      assert.notEqual(realSyncIndex, -1, 'expected to find the real target sync call');
      assert.ok(
        tempGateIndex < realSyncIndex,
        'the real target sync must happen only after the temp target public gate block',
      );
      assert.ok(step6SummaryIndex > realSyncIndex, 'the final summary should only run after the real target sync');
      assert.match(
        content,
        /run_target_public_gate "\$VALIDATION_TARGET_DIR"/,
        'full sync should reuse run_target_public_gate for the temp target check',
      );
    });

    it('temp target public gate appends the validation checkout to PROJECT_ALLOWED_ROOTS', () => {
      const gate = readFunctionBody(readSyncScript(), 'run_target_public_gate');
      assert.match(
        gate,
        /gate_target_real="\$\(resolve_physical_path "\$gate_target"\)"/,
        'run_target_public_gate should canonicalize the temp target root before exporting PROJECT_ALLOWED_ROOTS',
      );
      assert.match(
        gate,
        /PROJECT_ALLOWED_ROOTS_APPEND=true[\s\\]+PROJECT_ALLOWED_ROOTS="\$gate_target_real"[\s\\]+pnpm --filter @cat-cafe\/api run test:public/,
        'test:public in the temp target should treat the validation checkout as an allowed project root',
      );
      assert.match(
        gate,
        /PROJECT_ALLOWED_ROOTS_APPEND=true[\s\\]+PROJECT_ALLOWED_ROOTS="\$gate_target_real"[\s\\]+API_SERVER_PORT=\$accept_api_port MEMORY_STORE=1 NODE_ENV=test/,
        'API startup acceptance should reuse the same temp-target allow-root so projectPath-based dispatch stays representative',
      );
    });

    it('temp target public gate preserves full test:public output before tailing', () => {
      const gate = readFunctionBody(readSyncScript(), 'run_target_public_gate');
      assert.match(
        gate,
        /test_public_log=\$\(mktemp "\$\{TMPDIR:-\/tmp\}\/cat-cafe-testpublic\.XXXXXX"\)/,
        'run_target_public_gate should capture test:public output in a dedicated temp log',
      );
      assert.match(
        gate,
        /pnpm --filter @cat-cafe\/api run test:public >"\$test_public_log" 2>&1/,
        'test:public should write its full output to a log file before summary tailing',
      );
      assert.match(
        gate,
        /tail -20 "\$test_public_log"/,
        'failure path should print a larger tail from the captured test:public log',
      );
      assert.doesNotMatch(
        gate,
        /pnpm --filter @cat-cafe\/api run test:public 2>&1 \| tail -5/,
        'test:public should not pipe directly into tail, or failures become opaque',
      );
    });
  },
);

describe(
  'Sync runtime-safety guards stay source-side and shell-safe',
  { skip: !isHomeRepo && 'sync infrastructure not present (open-source repo)' },
  () => {
    it('resolves TARGET_DIR through a physical-path helper before safety checks', () => {
      const content = readSyncScript();
      assert.match(
        content,
        /resolve_physical_path\(\) \{[\s\S]*os\.path\.realpath\(sys\.argv\[1\]\)/,
        'sync script should resolve TARGET_DIR through a realpath helper so symlink aliases cannot bypass the guard',
      );
      assert.match(
        content,
        /RESOLVED_TARGET="\$\(resolve_physical_path "\$TARGET_DIR"\)"/,
        'sync script should guard on the resolved physical TARGET_DIR path',
      );
      assert.match(
        content,
        /list_source_worktree_realpaths \| grep -qFx "\$RESOLVED_TARGET"/,
        'sync script should compare TARGET_DIR against source worktrees using resolved realpaths',
      );
    });

    it('startup acceptance ports do not inherit runtime shell env', () => {
      const content = readSyncScript();
      assert.doesNotMatch(
        content,
        /ACCEPT_API_PORT=\$\{API_SERVER_PORT:-3004\}|accept_api_port=\$\{API_SERVER_PORT:-3004\}/,
        'startup acceptance must not inherit API_SERVER_PORT from the parent shell',
      );
      assert.doesNotMatch(
        content,
        /ACCEPT_WEB_PORT=\$\{FRONTEND_PORT:-3003\}|accept_web_port=\$\{FRONTEND_PORT:-3003\}/,
        'startup acceptance must not inherit FRONTEND_PORT from the parent shell',
      );
      assert.match(
        content,
        /accept_api_port="\$\(find_available_port 3004\)"/,
        'startup acceptance should choose its API port from a script-owned helper',
      );
      assert.match(
        content,
        /accept_web_port="\$\(find_available_port 3003 "\$accept_api_port"\)"/,
        'startup acceptance should choose a distinct frontend port from a script-owned helper',
      );
    });

    it('startup acceptance does not treat the public Preview Gateway port as forbidden leakage', () => {
      const gate = readFunctionBody(readSyncScript(), 'run_target_public_gate');
      assert.match(
        gate,
        /forbidden_ports="3001\|3002\|3011\|3012\|4111\|4000\|6398\|6399"/,
        'startup acceptance should only block internal/runtime ports, not the public Preview Gateway default',
      );
      assert.doesNotMatch(
        gate,
        /forbidden_ports=.*4100/,
        'startup acceptance must not reject the exported Preview Gateway default port 4100',
      );
    });
  },
);

describe(
  'Public-facing skill docs avoid home-only API defaults',
  { skip: !isHomeRepo && 'sync infrastructure not present (open-source repo)' },
  () => {
    it('workspace-navigator uses API_SERVER_PORT env instead of hardcoded 3002 fallbacks', () => {
      const content = readFileSync(resolve(ROOT, 'cat-cafe-skills/workspace-navigator/SKILL.md'), 'utf-8');
      assert.doesNotMatch(
        content,
        /API_SERVER_PORT=3002|API_SERVER_PORT:-3002/,
        'workspace-navigator should not hardcode the home-only API default in public-facing usage guidance',
      );
      assert.match(
        content,
        /API_PORT="\$\{API_SERVER_PORT:\?set API_SERVER_PORT before calling Navigate API\}"/,
        'workspace-navigator should teach readers to source the API port from the runtime environment',
      );
    });
  },
);
