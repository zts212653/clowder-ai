import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveOpenAIPlatformAccount } from '../src/config/account-resolver.js';
import { platformAccountProjectRoot } from '../src/config/platform-authentication.js';

test('a host CLI launched from another project finds household accounts through its Git common root without launch env', () => {
  const root = mkdtempSync(join(tmpdir(), 'platform-root-'));
  const main = join(root, 'home');
  const feature = join(root, 'feature');
  const previous = { ...process.env };
  const cwd = process.cwd();
  const git = (args: string[]) => execFileSync('git', args, { cwd: main, stdio: 'ignore' });
  try {
    for (const key of [
      'CAT_CAFE_CONFIG_ROOT',
      'CAT_CAFE_WORKSPACE_ROOT',
      'CAT_CAFE_RUNTIME_ROOT',
      'CAT_CAFE_GLOBAL_CONFIG_ROOT',
      'CAT_TEMPLATE_PATH',
    ])
      delete process.env[key];
    mkdirSync(main);
    git(['init', '-q']);
    writeFileSync(join(main, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    git(['add', 'pnpm-workspace.yaml']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
    git(['worktree', 'add', '-q', '--detach', feature]);
    mkdirSync(join(main, '.cat-cafe'));
    writeFileSync(
      join(main, '.cat-cafe/accounts.json'),
      JSON.stringify({ '11': { clientId: 'openai', authType: 'api_key' } }),
    );
    writeFileSync(join(main, '.cat-cafe/credentials.json'), JSON.stringify({ '11': { apiKey: 'FAKE_ROOT_KEY' } }));
    const external = join(root, 'consumer');
    mkdirSync(external);
    process.chdir(external);
    const accountRoot = platformAccountProjectRoot(feature);
    assert.equal(realpathSync(accountRoot), realpathSync(main));
    assert.equal(resolveOpenAIPlatformAccount(accountRoot, '11')?.id, '11');
    process.env.CAT_CAFE_CONFIG_ROOT = feature;
    assert.equal(
      realpathSync(platformAccountProjectRoot(feature)),
      realpathSync(feature),
      'explicit config root must stay explicit',
    );
  } finally {
    process.chdir(cwd);
    process.env = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
