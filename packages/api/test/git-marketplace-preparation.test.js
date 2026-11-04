import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  MarketplacePreparationError,
  prepareMarketplaceDirectory,
} from '../dist/domains/plugin/manager/marketplace/git-marketplace-preparation.js';

async function fixture(
  t,
  rootManifest = { name: 'marketplace', packageManager: 'pnpm@9.15.4' },
  pluginManifest = {
    name: '@example/demo',
    scripts: { build: 'node build.mjs' },
  },
) {
  const root = await mkdtemp(join(tmpdir(), 'marketplace-preparation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'packages/demo');
  await mkdir(directory, { recursive: true });
  await writeFile(join(root, 'package.json'), `${JSON.stringify(rootManifest)}\n`);
  await writeFile(join(directory, 'package.json'), `${JSON.stringify(pluginManifest)}\n`);
  return { root, directory };
}

test('uses the Host-adjacent Corepack with the repository exact pnpm version for install and build', async (t) => {
  const f = await fixture(t);
  const calls = [];

  await prepareMarketplaceDirectory(f.directory, f.root, {
    platform: 'linux',
    execPath: '/opt/clowder/node/bin/node',
    exists: () => true,
    exec: async (command, args, options) => {
      calls.push({ command, args, options });
      return { stdout: '', stderr: '' };
    },
  });

  assert.deepEqual(
    calls.map(({ command, args }) => ({ command, args })),
    [
      {
        command: '/opt/clowder/node/bin/corepack',
        args: ['pnpm@9.15.4', 'install', '--frozen-lockfile'],
      },
      {
        command: '/opt/clowder/node/bin/corepack',
        args: ['pnpm@9.15.4', '--filter', '@example/demo...', 'build'],
      },
    ],
  );
  const env = calls[0].options.env;
  assert.equal(env.CI, 'true');
  assert.equal(env.COREPACK_ENABLE_DOWNLOAD_PROMPT, '0');
  assert.equal(env.COREPACK_ENABLE_PROJECT_SPEC, '1');
  assert.equal(env.COREPACK_ENABLE_STRICT, '1');
});

test('resolves the Windows Corepack shim adjacent to the Host Node before spawning', async (t) => {
  const f = await fixture(t, undefined, { name: '@example/demo' });
  const plans = [];
  const calls = [];

  await prepareMarketplaceDirectory(f.directory, f.root, {
    platform: 'win32',
    execPath: 'C:\\Clowder\\runtime\\node.exe',
    exists: () => true,
    windowsSpawnPlan: (command, args) => {
      plans.push({ command, args });
      return { command: 'C:\\Clowder\\runtime\\node.exe', args: ['corepack.js', ...args], shell: undefined };
    },
    exec: async (command, args, options) => {
      calls.push({ command, args, shell: options.shell });
      return { stdout: '', stderr: '' };
    },
  });

  assert.deepEqual(plans, [
    {
      command: 'C:\\Clowder\\runtime\\corepack.cmd',
      args: ['pnpm@9.15.4', 'install', '--frozen-lockfile'],
    },
  ]);
  assert.deepEqual(calls, [
    {
      command: 'C:\\Clowder\\runtime\\node.exe',
      args: ['corepack.js', 'pnpm@9.15.4', 'install', '--frozen-lockfile'],
      shell: undefined,
    },
  ]);
});

test('rejects repositories without an exact pnpm packageManager declaration', async (t) => {
  for (const [label, manifest] of [
    ['missing', { name: 'marketplace' }],
    ['range', { name: 'marketplace', packageManager: 'pnpm@^9.15.4' }],
    ['other manager', { name: 'marketplace', packageManager: 'npm@10.9.0' }],
  ]) {
    await t.test(label, async (t) => {
      const f = await fixture(t, manifest, { name: '@example/demo' });
      let executed = false;
      await assert.rejects(
        prepareMarketplaceDirectory(f.directory, f.root, {
          platform: 'linux',
          execPath: '/opt/clowder/node/bin/node',
          exists: () => true,
          exec: async () => {
            executed = true;
            return { stdout: '', stderr: '' };
          },
        }),
        /exact pnpm version/i,
      );
      assert.equal(executed, false);
    });
  }
});

test('fails closed when the Host-adjacent Corepack executable is unavailable', async (t) => {
  const f = await fixture(t, undefined, { name: '@example/demo' });
  await assert.rejects(
    prepareMarketplaceDirectory(f.directory, f.root, {
      platform: 'linux',
      execPath: '/opt/clowder/node/bin/node',
      exists: () => false,
      exec: async () => ({ stdout: '', stderr: '' }),
    }),
    /Host-bundled Corepack/i,
  );
});

test('reports bounded sanitized child diagnostics without leaking credentials or paths', async (t) => {
  const f = await fixture(t, undefined, { name: '@example/demo' });
  const token = `github_pat_${'A'.repeat(82)}`;
  const failure = Object.assign(new Error('raw command failure'), {
    code: 1,
    stderr: `C:\\Users\\alice\\private\\repo Error: ERR_PNPM_IGNORED_BUILDS token=${token}\n${'x'.repeat(2_000)}`,
  });

  await assert.rejects(
    prepareMarketplaceDirectory(f.directory, f.root, {
      platform: 'linux',
      execPath: '/opt/clowder/node/bin/node',
      exists: () => true,
      exec: async () => Promise.reject(failure),
    }),
    (error) => {
      assert.ok(error instanceof MarketplacePreparationError);
      assert.equal(error.diagnostic.packageManager, 'pnpm@9.15.4');
      assert.equal(error.diagnostic.phase, 'install');
      assert.equal(error.diagnostic.exitCode, 1);
      assert.match(error.diagnostic.stderrExcerpt, /ERR_PNPM_IGNORED_BUILDS/);
      assert.match(error.diagnostic.stderrExcerpt, /\[TOKEN_REDACTED\]/);
      assert.doesNotMatch(error.diagnostic.stderrExcerpt, /github_pat_|alice/);
      assert.ok(error.diagnostic.stderrExcerpt.length <= 1_000);
      assert.doesNotMatch(error.message, /github_pat_|alice/);
      return true;
    },
  );
});
