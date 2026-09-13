// INV-9 / P1-1 static checks on scripts/runtime-worktree.sh.
//
// INV-9: seed_runtime_config_from_project must NOT copy accounts.json or
// credentials.json into the disposable runtime checkout — those stores belong
// to the durable workspace and are migrated at startup, not re-seeded stale.
// P1-1: the script must not export a CAT_CAFE_GLOBAL_CONFIG_ROOT default —
// doing so suppresses the runtime→workspace stale-store migration.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SELF_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SELF_DIR, '..');
const SCRIPT_PATH = resolve(SELF_DIR, 'runtime-worktree.sh');
const script = readFileSync(SCRIPT_PATH, 'utf-8');

function extractSeedFileLoop(source) {
  const match = source.match(/for file in ([^;]+); do/);
  return match ? match[1].split(/\s+/).filter(Boolean) : [];
}

describe('runtime-worktree.sh seed restriction (INV-9)', () => {
  it('seed_runtime_config_from_project copies only cat-catalog.json', () => {
    const seedSection = script.match(/seed_runtime_config_from_project\(\) \{[\s\S]*?\n\}/)?.[0] ?? '';
    assert.ok(seedSection.length > 0, 'seed function must exist');
    const files = extractSeedFileLoop(seedSection);
    assert.deepEqual(files, ['cat-catalog.json'], 'only cat-catalog.json may be seeded into runtime');
  });

  it('no accounts.json / credentials.json copy anywhere in the seed function', () => {
    const seedSection = script.match(/seed_runtime_config_from_project\(\) \{[\s\S]*?\n\}/)?.[0] ?? '';
    assert.ok(!seedSection.includes('accounts.json'), 'accounts.json must not be seeded');
    assert.ok(!seedSection.includes('credentials.json'), 'credentials.json must not be seeded');
  });
});

describe('runtime-worktree.sh store-root default (P1-1)', () => {
  it('does not export CAT_CAFE_GLOBAL_CONFIG_ROOT with a default value', () => {
    assert.ok(
      !/export CAT_CAFE_GLOBAL_CONFIG_ROOT=/.test(script),
      'script must not default-export CAT_CAFE_GLOBAL_CONFIG_ROOT (suppresses stale-store migration)',
    );
  });

  it('exports CAT_CAFE_DEPLOYMENT_ID=runtime', () => {
    assert.ok(
      /export CAT_CAFE_DEPLOYMENT_ID=runtime/.test(script),
      'script must export CAT_CAFE_DEPLOYMENT_ID=runtime',
    );
  });

  it('keeps CAT_CAFE_RUNTIME_ROOT and CAT_CAFE_WORKSPACE_ROOT exports', () => {
    assert.ok(/export CAT_CAFE_RUNTIME_ROOT=/.test(script), 'RUNTIME_ROOT export required');
    assert.ok(/export CAT_CAFE_WORKSPACE_ROOT=/.test(script), 'WORKSPACE_ROOT export required');
  });
});

describe('runtime-worktree.sh self-root fail-closed boundary', () => {
  function probe({ projectRoot, runtimeRoot, workspaceRoot }) {
    const result = spawnSync(
      'bash',
      [
        '-c',
        [
          'source "$1" --source-only',
          'PROJECT_DIR="$2"',
          'RUNTIME_DIR="$3"',
          'if [ -n "$4" ]; then export CAT_CAFE_WORKSPACE_ROOT="$4"; else unset CAT_CAFE_WORKSPACE_ROOT; fi',
          'ensure_runtime_workspace_boundary',
        ].join('\n'),
        '_',
        SCRIPT_PATH,
        projectRoot,
        runtimeRoot,
        workspaceRoot ?? '',
      ],
      { encoding: 'utf8' },
    );
    return result;
  }

  it('refuses to start when the disposable runtime checkout would also become the persistent workspace', () => {
    const result = probe({ projectRoot: ROOT, runtimeRoot: ROOT });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /runtime checkout as the persistent workspace/);
  });

  it('allows a self-located script only with a distinct explicit persistent workspace', () => {
    const result = probe({
      projectRoot: ROOT,
      runtimeRoot: ROOT,
      workspaceRoot: '/tmp/persistent-workspace',
    });
    assert.equal(result.status, 0, result.stderr);
  });

  it('checks the workspace boundary before restart authorization can touch the live runtime', () => {
    const startSection = script.match(/start_runtime_worktree\(\) \{[\s\S]*?\n\}/)?.[0] ?? '';
    assert.ok(startSection.length > 0, 'start function must exist');
    const boundary = startSection.indexOf('ensure_runtime_workspace_boundary');
    const restart = startSection.indexOf('ensure_restart_authorized');
    assert.ok(boundary >= 0, 'start must enforce the workspace boundary');
    assert.ok(restart >= 0, 'start must retain restart authorization');
    assert.ok(boundary < restart, 'workspace boundary must fail before restart authorization');
  });
});
