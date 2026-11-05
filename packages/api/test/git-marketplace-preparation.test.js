import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  MarketplacePreparationError,
  prepareMarketplaceDirectory,
} from '../dist/domains/plugin/manager/marketplace/git-marketplace-preparation.js';

function readPath(env) {
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === 'PATH');
  return key ? env[key] : undefined;
}

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

test('uses the Host-adjacent Corepack and pins lifecycle pnpm resolution for install and build', async (t) => {
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
        command: '/opt/clowder/node/bin/node',
        args: [
          '/opt/clowder/node/lib/node_modules/corepack/dist/corepack.js',
          'enable',
          'pnpm',
          '--install-directory',
          calls[0].args[4],
        ],
      },
      {
        command: '/opt/clowder/node/bin/node',
        args: [
          '/opt/clowder/node/lib/node_modules/corepack/dist/corepack.js',
          'pnpm@9.15.4',
          'install',
          '--frozen-lockfile',
        ],
      },
      {
        command: '/opt/clowder/node/bin/node',
        args: [
          '/opt/clowder/node/lib/node_modules/corepack/dist/corepack.js',
          'pnpm@9.15.4',
          '--filter',
          '@example/demo...',
          'build',
        ],
      },
    ],
  );
  const shimDirectory = calls[0].args[4];
  assert.equal(typeof shimDirectory, 'string');
  const expectedPath = process.env.PATH ? `${shimDirectory}:${process.env.PATH}` : shimDirectory;
  assert.equal(readPath(calls[1].options.env), expectedPath);
  assert.equal(readPath(calls[2].options.env), expectedPath);
  const env = calls[1].options.env;
  assert.equal(env.CI, 'true');
  assert.equal(env.COREPACK_ENABLE_DOWNLOAD_PROMPT, '0');
  assert.equal(env.COREPACK_ENABLE_PROJECT_SPEC, '1');
  assert.equal(env.COREPACK_ENABLE_STRICT, '1');
});

test('runs the Windows Corepack entry with the same Host Node instead of a system Node', async (t) => {
  const f = await fixture(t, undefined, { name: '@example/demo' });
  const calls = [];

  await prepareMarketplaceDirectory(f.directory, f.root, {
    platform: 'win32',
    execPath: 'C:\\Clowder\\runtime\\node.exe',
    exists: () => true,
    exec: async (command, args, options) => {
      calls.push({ command, args, shell: options.shell, envPath: readPath(options.env) });
      return { stdout: '', stderr: '' };
    },
  });

  const shimDirectory = calls[0].args[4];
  assert.deepEqual(calls, [
    {
      command: 'C:\\Clowder\\runtime\\node.exe',
      args: [
        'C:\\Clowder\\runtime\\node_modules\\corepack\\dist\\corepack.js',
        'enable',
        'pnpm',
        '--install-directory',
        shimDirectory,
      ],
      shell: undefined,
      envPath: process.env.PATH,
    },
    {
      command: 'C:\\Clowder\\runtime\\node.exe',
      args: [
        'C:\\Clowder\\runtime\\node_modules\\corepack\\dist\\corepack.js',
        'pnpm@9.15.4',
        'install',
        '--frozen-lockfile',
      ],
      shell: undefined,
      envPath: process.env.PATH ? `${shimDirectory};${process.env.PATH}` : shimDirectory,
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

test('fails closed when the Host-bundled Corepack entry script is unavailable', async (t) => {
  const f = await fixture(t, undefined, { name: '@example/demo' });
  await assert.rejects(
    prepareMarketplaceDirectory(f.directory, f.root, {
      platform: 'linux',
      execPath: '/opt/clowder/node/bin/node',
      exists: (candidate) => !candidate.endsWith('/corepack/dist/corepack.js'),
      exec: async () => ({ stdout: '', stderr: '' }),
    }),
    /Host-bundled Corepack entry script/i,
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

test('uses sanitized stdout when pnpm fails without stderr output', async (t) => {
  const f = await fixture(t, undefined, { name: '@example/demo' });
  const token = `github_pat_${'B'.repeat(82)}`;
  let invocation = 0;

  await assert.rejects(
    prepareMarketplaceDirectory(f.directory, f.root, {
      platform: 'linux',
      execPath: '/opt/clowder/node/bin/node',
      exists: () => true,
      exec: async () => {
        invocation += 1;
        if (invocation === 1) return { stdout: '', stderr: '' };
        throw Object.assign(new Error('raw command failure'), {
          code: 1,
          stderr: '',
          stdout: `ERR_PNPM_OUTDATED_LOCKFILE token=${token}`,
        });
      },
    }),
    (error) => {
      assert.ok(error instanceof MarketplacePreparationError);
      assert.match(error.diagnostic.stderrExcerpt, /ERR_PNPM_OUTDATED_LOCKFILE/);
      assert.match(error.diagnostic.stderrExcerpt, /\[TOKEN_REDACTED\]/);
      assert.doesNotMatch(error.diagnostic.stderrExcerpt, /github_pat_/);
      return true;
    },
  );
});

test('preserves both output streams and redacts basic-auth URLs before bounding diagnostics', async (t) => {
  const f = await fixture(t, undefined, { name: '@example/demo' });
  let invocation = 0;

  await assert.rejects(
    prepareMarketplaceDirectory(f.directory, f.root, {
      platform: 'linux',
      execPath: '/opt/clowder/node/bin/node',
      exists: () => true,
      exec: async () => {
        invocation += 1;
        if (invocation === 1) return { stdout: '', stderr: '' };
        throw Object.assign(new Error('raw command failure'), {
          code: 7,
          stderr: 'Warning: deprecated SDK helper',
          stdout: 'ERR_ACTUAL_BUILD_FAILURE https://alice:review-password@registry.example.test/private.tgz',
        });
      },
    }),
    (error) => {
      assert.ok(error instanceof MarketplacePreparationError);
      assert.equal(error.diagnostic.exitCode, 7);
      assert.match(error.diagnostic.stderrExcerpt, /Warning: deprecated SDK helper/);
      assert.match(error.diagnostic.stderrExcerpt, /ERR_ACTUAL_BUILD_FAILURE/);
      assert.match(error.diagnostic.stderrExcerpt, /\[CREDENTIALS_REDACTED\]/);
      assert.doesNotMatch(error.diagnostic.stderrExcerpt, /alice|review-password/);
      assert.doesNotMatch(error.message, /alice|review-password/);
      assert.ok(error.diagnostic.stderrExcerpt.length <= 1_000);
      return true;
    },
  );
});
