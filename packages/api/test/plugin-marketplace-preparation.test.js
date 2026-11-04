import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const preparation = new URL(
  '../dist/domains/plugin/manager/marketplace/git-marketplace-preparation.js',
  import.meta.url,
);

async function fixture(t, rootPackage = { packageManager: 'pnpm@9.15.4' }, environment = {}) {
  const root = await mkdtemp(join(tmpdir(), 'marketplace preparation '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'packages/demo');
  const bin = join(root, 'bin');
  const log = join(root, 'calls.jsonl');
  await mkdir(directory, { recursive: true });
  await mkdir(bin);
  await writeFile(log, '');
  const preload = join(bin, 'npm-fixture-preload.cjs');
  await writeFile(
    preload,
    `
    if (process.argv[1]?.replace(/\\\\/g, '/').endsWith('/npm-cli.js')) {
      require(process.env.FIXTURE_NPM_SCRIPT);
      process.exit(process.exitCode ?? 0);
    }
  `,
  );
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'marketplace', ...rootPackage }));
  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify({ name: '@example/demo', packageManager: 'pnpm@12.11.2', scripts: { build: 'ignored by fixture' } }),
  );
  for (const name of ['npm', 'pnpm']) {
    const source = `
      const { appendFileSync } = require('node:fs');
      const args = process.argv.slice(2);
      appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({ launcher: '${name}', args }) + '\\n');
      const pinned = args.find((arg) => arg.startsWith('--package=pnpm@'))?.slice('--package=pnpm@'.length);
      if (args.includes('--version')) {
        console.log(process.env.FIXTURE_ACTUAL_VERSION || pinned || '12.11.2');
      } else if (process.env.FIXTURE_FAIL_STAGE && args.includes(process.env.FIXTURE_FAIL_STAGE)) {
        console.log('ERR_PNPM_IGNORED_BUILDS: esbuild requires approval');
        console.error('Bearer ghp_1234567890abcdefghijklmnopqrstuvwxyzABCD ' + process.env.FIXTURE_ROOT);
        console.error('x'.repeat(6000));
        process.exitCode = 17;
      } else if (args.includes('install') && !args.includes('--frozen-lockfile')) {
        process.exitCode = 18;
      }
    `;
    await writeFile(join(bin, `${name}.js`), source);
    await writeFile(join(bin, `${name}.cmd`), `@echo off\r\n"${process.execPath}" "%~dp0\\${name}.js" %*\r\n`);
    await writeFile(join(bin, name), `#!/usr/bin/env node\n${source}`);
    await chmod(join(bin, name), 0o755);
  }
  const run = async () => {
    const { stdout } = await exec(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      const { prepareMarketplaceDirectory } = await import(${JSON.stringify(preparation.href)});
      await prepareMarketplaceDirectory(process.env.FIXTURE_DIRECTORY, process.env.FIXTURE_ROOT).then(
        () => console.log(JSON.stringify({ ok: true })),
        (error) => console.log(JSON.stringify({ ok: false, message: error.message, diagnostic: error.diagnostic })),
      );
    `,
      ],
      {
        cwd: root,
        windowsHide: true,
        env: {
          ...process.env,
          PATH: `${bin}${delimiter}${process.env.PATH}`,
          COREPACK_ROOT: 'inherited-unrelated-corepack',
          npm_config_manage_package_manager_versions: 'false',
          pnpm_config_pm_on_fail: 'ignore',
          FIXTURE_LOG: log,
          FIXTURE_ROOT: root,
          FIXTURE_DIRECTORY: directory,
          FIXTURE_NPM_SCRIPT: join(bin, 'npm.js'),
          NODE_OPTIONS: `--require "${preload.replace(/\\/g, '/')}"`,
          ...environment,
        },
      },
    );
    return JSON.parse(stdout);
  };
  const calls = async () =>
    (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  return { root, run, calls };
}

test('Git preparation uses the repository pnpm pin for version, frozen install and filtered build', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.run(), { ok: true });
  const calls = await f.calls();
  assert.equal(calls.length, 3);
  assert.ok(calls.every(({ launcher, args }) => launcher === 'npm' && args.includes('--package=pnpm@9.15.4')));
  assert.ok(calls[0].args.includes('--version'));
  assert.deepEqual(calls[1].args.slice(-2), ['install', '--frozen-lockfile']);
  assert.deepEqual(calls[2].args.slice(-3), ['--filter', '@example/demo...', 'build']);
  assert.ok(calls.every(({ args }) => !args.some((arg) => /allow-all-builds|strict-dep-builds/.test(arg))));
});

test('Git preparation refuses an unexpected effective pnpm version before installation', async (t) => {
  const f = await fixture(t, undefined, { FIXTURE_ACTUAL_VERSION: '12.11.2' });
  const result = await f.run();
  assert.equal(result.ok, false);
  assert.match(result.message, /9\.15\.4/);
  assert.match(result.message, /12\.11\.2/);
  assert.equal(result.diagnostic.actualVersion, '12.11.2');
  assert.equal(
    (await f.calls()).some(({ args }) => args.includes('install')),
    false,
  );
});

test('Git preparation preserves global pnpm behavior for a repository without a packageManager pin', async (t) => {
  const f = await fixture(t, {});
  assert.deepEqual(await f.run(), { ok: true });
  assert.ok((await f.calls()).every(({ launcher }) => launcher === 'pnpm'));
});

test('Git preparation rejects unsupported packageManager declarations before running commands', async (t) => {
  for (const packageManager of ['npm@10.0.0', 'pnpm@latest', 'pnpm@9.15.4 --ignore-scripts', 12]) {
    const f = await fixture(t, { packageManager });
    assert.equal((await f.run()).ok, false, String(packageManager));
    assert.deepEqual(await f.calls(), []);
  }
});

test('Git preparation returns bounded, sanitized exit diagnostics including pnpm stdout errors', async (t) => {
  const f = await fixture(t, undefined, { FIXTURE_FAIL_STAGE: 'install' });
  const result = await f.run();
  assert.equal(result.ok, false);
  assert.match(result.message, /ERR_PNPM_IGNORED_BUILDS/);
  assert.match(result.message, /17/);
  assert.equal(result.diagnostic.stage, 'install');
  assert.equal(result.diagnostic.requestedVersion, '9.15.4');
  assert.equal(result.diagnostic.actualVersion, '9.15.4');
  assert.equal(result.diagnostic.exitCode, 17);
  assert.ok(result.diagnostic.output.length <= 2048);
  assert.ok(result.message.length < 2400);
  assert.equal(result.message.includes(f.root), false);
  assert.equal(result.message.includes('ghp_1234567890abcdefghijklmnopqrstuvwxyzABCD'), false);
  assert.equal(
    (await f.calls()).some(({ args }) => args.includes('build')),
    false,
  );
});

test('Git preparation identifies build failures separately from dependency installation', async (t) => {
  const f = await fixture(t, undefined, { FIXTURE_FAIL_STAGE: 'build' });
  const result = await f.run();
  assert.equal(result.ok, false);
  assert.equal(result.diagnostic.stage, 'build');
  assert.equal(result.diagnostic.exitCode, 17);
  assert.equal((await f.calls()).length, 3);
});
