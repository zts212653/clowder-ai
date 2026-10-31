import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { finalizeCodexAccountEnvironment } from '../src/config/codex-account-environment.js';
import { readCodexAccountIdentity } from '../src/config/codex-account-identity.js';
import { codexManagedLaunchArgs } from '../src/config/codex-managed-launch.js';
import { buildChildEnv } from '../src/utils/cli-spawn.js';
import { ownedManagedFixture } from './helpers/f320-owned-account.js';

const playwrightModule = createRequire(new URL('../../ppt-forge/package.json', import.meta.url)).resolve('playwright');
const browserPathProbe = `console.log(require(${JSON.stringify(playwrightModule)}).chromium.executablePath())`;

const probe = `
  const { homedir } = require('node:os');
  const { join } = require('node:path');
  const { readFileSync, existsSync } = require('node:fs');
  const home = homedir();
  const config = process.env.XDG_CONFIG_HOME || join(home, '.config');
  console.log(JSON.stringify({
    home,
    gh: readFileSync(join(process.env.GH_CONFIG_DIR || join(config, 'gh'), 'config.yml'), 'utf8'),
    git: readFileSync(process.env.GIT_CONFIG_GLOBAL || join(home, '.gitconfig'), 'utf8'),
    ssh: readFileSync(join(home, '.ssh', 'config'), 'utf8'),
    browser: existsSync(require(${JSON.stringify(playwrightModule)}).chromium.executablePath()),
    extension: existsSync(join(home, '.vscode', 'extensions', 'fixture-extension')),
    codexHome: process.env.CODEX_HOME,
    sqliteHome: process.env.CODEX_SQLITE_HOME,
  }));
`;

for (const explicitPaths of [false, true]) {
  test(`managed OAuth keeps host tools and private auth (${explicitPaths ? 'explicit tool paths' : 'home defaults'})`, () => {
    const f = ownedManagedFixture();
    try {
      for (const key of [
        'GH_CONFIG_DIR',
        'XDG_CONFIG_HOME',
        'XDG_CACHE_HOME',
        'GIT_CONFIG_GLOBAL',
        'PLAYWRIGHT_BROWSERS_PATH',
      ])
        delete process.env[key];
      const config = join(f.root, explicitPaths ? 'selected-config' : '.config');
      const cache = join(f.root, explicitPaths ? 'selected-cache' : '.cache');
      const git = join(f.root, explicitPaths ? 'selected-gitconfig' : '.gitconfig');
      for (const path of [
        join(config, 'gh'),
        join(cache, 'ms-playwright'),
        join(f.root, '.ssh'),
        join(f.root, '.vscode', 'extensions'),
      ])
        mkdirSync(path, { recursive: true });
      writeFileSync(join(config, 'gh', 'config.yml'), 'fixture-gh-settings');
      writeFileSync(git, 'fixture-git-settings');
      writeFileSync(join(f.root, '.ssh', 'config'), 'fixture-ssh-settings');
      writeFileSync(join(f.root, '.vscode', 'extensions', 'fixture-extension'), 'fixture');
      if (explicitPaths)
        Object.assign(process.env, {
          XDG_CONFIG_HOME: config,
          XDG_CACHE_HOME: cache,
          GH_CONFIG_DIR: join(config, 'gh'),
          GIT_CONFIG_GLOBAL: git,
          PLAYWRIGHT_BROWSERS_PATH: join(cache, 'ms-playwright'),
        });
      const browserPath = execFileSync(process.execPath, ['-e', browserPathProbe], {
        env: process.env,
        encoding: 'utf8',
      }).trim();
      assert.ok(browserPath.startsWith(`${f.root}/`), 'browser fixture must stay in its own home');
      mkdirSync(dirname(browserPath), { recursive: true });
      writeFileSync(browserPath, 'fixture-browser');
      const args = codexManagedLaunchArgs(f.launch, []);
      const finalized = finalizeCodexAccountEnvironment(f.launch, {
        cwd: f.external,
        env: { ...f.account.envVars },
        args,
      });
      const env = buildChildEnv(finalized, { workingDirectory: f.external });
      const result = JSON.parse(
        execFileSync(process.execPath, ['-e', probe], {
          cwd: f.external,
          env,
          encoding: 'utf8',
        }),
      );
      assert.deepEqual(result, {
        home: f.root,
        gh: 'fixture-gh-settings',
        git: 'fixture-git-settings',
        ssh: 'fixture-ssh-settings',
        browser: true,
        extension: true,
        codexHome: f.layout.credentialHome,
        sqliteHome: f.state,
      });
      assert.equal(process.env.HOME, f.root, 'resolving an account never mutates its parent');
      assert.ok(args.includes('cli_auth_credentials_store="file"'));
      assert.ok(env.CODEX_HOME);
      assert.equal(readCodexAccountIdentity(env.CODEX_HOME).workspaceId, f.identity.workspaceId);
      assert.equal(finalized.OPENAI_API_KEY, null);
      assert.equal(finalized.CODEX_CAT_EXPECTED_CREDENTIAL_HOME, f.layout.credentialHome);
    } finally {
      f.close();
    }
  });
}

test(
  'installed managed file auth does not fall back to host OAuth when its private login disappears',
  {
    skip: process.platform !== 'darwin',
  },
  () => {
    const f = ownedManagedFixture();
    try {
      const args = codexManagedLaunchArgs(f.launch, []);
      const env = buildChildEnv(
        finalizeCodexAccountEnvironment(f.launch, {
          cwd: f.external,
          env: { ...f.account.envVars },
          args,
        }),
      );
      Object.assign(env, {
        HTTP_PROXY: 'http://127.0.0.1:1',
        HTTPS_PROXY: 'http://127.0.0.1:1',
        ALL_PROXY: 'http://127.0.0.1:1',
        NO_PROXY: '127.0.0.1,localhost',
      });
      // Runs on whatever version is installed; admission measures the same property per version.
      const loginPath = join(f.layout.credentialHome, 'auth.json');
      const fakeLogin = JSON.parse(readFileSync(loginPath, 'utf8'));
      fakeLogin.tokens.refresh_token = 'fixture-refresh-b';
      fakeLogin.last_refresh = new Date().toISOString();
      const fakeBytes = JSON.stringify(fakeLogin);
      writeFileSync(loginPath, fakeBytes);
      mkdirSync(join(f.root, '.codex'));
      writeFileSync(join(f.root, '.codex', 'auth.json'), fakeBytes);
      const command = ['--config', 'cli_auth_credentials_store="file"', 'login', 'status'];
      const ready = spawnSync('codex', command, { env, encoding: 'utf8', timeout: 5000 });
      assert.equal(ready.status, 0, ready.stderr);
      unlinkSync(loginPath);
      const missing = spawnSync('codex', command, { env, encoding: 'utf8', timeout: 5000 });
      assert.notEqual(missing.status, 0);
      assert.match(missing.stderr, /not logged in/i);
      assert.equal(process.env.HOME, f.root);
    } finally {
      f.close();
    }
  },
);
