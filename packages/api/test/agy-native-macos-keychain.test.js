import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { prepareAgyNativeLaunch } from '../dist/domains/cats/services/agents/providers/agy-native/agy-native-launch.js';

function security(home, args) {
  return execFileSync('/usr/bin/security', args, {
    env: { HOME: home, PATH: '/usr/bin:/bin' },
    encoding: 'utf8',
    timeout: 5000,
  });
}

function hostSnapshot() {
  const result = {};
  for (const command of ['default-keychain', 'list-keychains']) {
    const r = spawnSync('/usr/bin/security', [command, '-d', 'user'], {
      env: { HOME: homedir(), PATH: '/usr/bin:/bin' },
      encoding: 'utf8',
      timeout: 5000,
    });
    result[command] = { status: r.status, stdout: r.stdout };
  }
  const plist = join(homedir(), 'Library/Preferences/com.apple.security.plist');
  result.preferences = existsSync(plist) ? readFileSync(plist).toString('base64') : null;
  const login = join(homedir(), 'Library/Keychains/login.keychain-db');
  if (existsSync(login)) {
    const s = statSync(login);
    result.loginMetadata = { size: s.size, mtimeMs: s.mtimeMs };
  }
  return result;
}

test(
  'real Native preparation isolates macOS default credentials without changing operator preferences',
  {
    skip: process.platform !== 'darwin',
  },
  async () => {
    const before = hostSnapshot();
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'f325-keychain-native-')));
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const plans = [];
    try {
      for (const id of ['profile-a', 'profile-b']) {
        const plan = await prepareAgyNativeLaunch({
          catId: 'gemini38',
          model: 'gemini-3.8-flash-high',
          command: '/usr/bin/true',
          workspace,
          prompt: 'No provider is launched.',
          body: '# Identity\nIsolated preparation only.',
          profileConfig: {
            enabled: true,
            profileId: id,
            homeRoot: join(root, 'profiles'),
            model: 'gemini-3.8-flash-high',
            autoApprove: true,
            trustedWorkspaces: [workspace],
          },
        });
        plans.push(plan);
        const home = plan.cliOptions.env.HOME;
        const keychain = join(home, 'Library/Keychains/cat-cafe.keychain-db');
        assert.equal(realpathSync(JSON.parse(security(home, ['default-keychain', '-d', 'user']).trim())), keychain);
        assert.deepEqual(
          security(home, ['list-keychains', '-d', 'user'])
            .trim()
            .split('\n')
            .map((x) => JSON.parse(x.trim())),
          [keychain],
        );
        assert.equal(plan.cliOptions.env.GEMINI_HOME, join(home, '.gemini'));
        // These are literal synthetic fixtures in temporary private stores.
        security(home, ['add-generic-password', '-s', 'f325-test-only', '-a', 'same-account', '-w', id, keychain]);
      }
      for (const [index, plan] of plans.entries()) {
        const home = plan.cliOptions.env.HOME;
        assert.equal(
          security(home, ['find-generic-password', '-s', 'f325-test-only', '-a', 'same-account', '-w']).trim(),
          ['profile-a', 'profile-b'][index],
        );
      }
    } finally {
      for (const plan of plans) {
        const home = plan.cliOptions.env.HOME;
        security(home, ['delete-keychain', join(home, 'Library/Keychains/cat-cafe.keychain-db')]);
        await plan.disposeCredentials?.();
      }
      rmSync(root, { recursive: true, force: true });
    }
    assert.deepEqual(
      hostSnapshot(),
      before,
      'Operator default/search/preferences/login metadata must remain unchanged',
    );
  },
);
