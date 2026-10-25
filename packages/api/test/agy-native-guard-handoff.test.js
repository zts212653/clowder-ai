import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { secretRuntimeScript } from '@cat-cafe/mcp-server/dist/secret-runtime.js';

const { materializeAgyNativeEffectGuard } = await import(
  '../dist/domains/cats/services/agents/providers/agy-native/agy-native-effect-guard.js'
);

test('Native guard can move between registered worktrees but refuses altered hook bytes', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'f325-guard-handoff-')));
  const repo = join(root, 'repo');
  const next = join(root, 'next');
  const home = join(root, 'profile');
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  mkdirSync(join(home, '.gemini/config'), { recursive: true });
  writeFileSync(join(repo, 'scripts/agy-native-effect-guard.mjs'), '// fixture guard\n');
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: 'pipe' });
  try {
    git('init', '--quiet');
    git('add', 'scripts');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '--quiet', '-m', 'fixture');
    git('worktree', 'add', '--quiet', '--detach', next);
    const path = materializeAgyNativeEffectGuard({ profileHome: home, runtimeRoot: repo, readOnly: false });
    materializeAgyNativeEffectGuard({ profileHome: home, runtimeRoot: next, readOnly: false });
    const config = readFileSync(path, 'utf8');
    assert.ok(config.includes(realpathSync(secretRuntimeScript('agy-native-effect-guard.mjs'))));
    assert.ok(
      !config.includes(join(next, 'scripts/agy-native-effect-guard.mjs')),
      'workspace code cannot replace the package-owned guard',
    );
    assert.ok(!config.includes(join(repo, 'scripts/agy-native-effect-guard.mjs')));
    writeFileSync(path, '{}');
    assert.throws(
      () => materializeAgyNativeEffectGuard({ profileHome: home, runtimeRoot: repo, readOnly: false }),
      /changed|altered/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
