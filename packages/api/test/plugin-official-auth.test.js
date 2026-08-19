import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { OfficialPluginAuthService } from '../dist/domains/plugin/index.js';
import { parseLarkCliJson, runOfficialPluginAuthCommand } from '../dist/domains/plugin/official-plugin-auth-command.js';

const runnerPath = 'node_modules/@larksuite/cli/scripts/run.js';

test('bounds and cancels the process tree used for blocking device authorization', async () => {
  const controller = new AbortController();
  const running = runOfficialPluginAuthCommand({
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1_000)'],
    cwd: process.cwd(),
    env: { HOME: process.env.HOME ?? tmpdir(), PATH: process.env.PATH ?? '/usr/bin:/bin' },
    timeoutMs: 5_000,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 25);
  await assert.rejects(running, /cancelled/);
});

test('bounds malformed prepared auth output without reparsing overlapping suffixes', () => {
  const nestingDepth = 8_000;
  const output = [
    'Preparing bundled lark-cli runtime...',
    '[\n'.repeat(nestingDepth),
    'not-json\n',
    ']\n'.repeat(nestingDepth),
    'trailing notifier output',
  ].join('');

  const startedAt = performance.now();
  assert.throws(() => parseLarkCliJson(output), /invalid structured output/);
  assert.ok(performance.now() - startedAt < 500, 'malformed 32 KiB output must be rejected promptly');
});

function target() {
  return {
    entry: {
      catalogId: 'feishu-meeting-intake',
      packageName: '@clowder-ai/feishu-meeting-intake',
      version: '0.1.0-alpha.2',
      pluginId: 'official.feishu-meeting-intake',
      archiveUrl: 'https://registry.npmjs.org/example.tgz',
      packageDigest: 'sha512-test',
      effectiveGrants: ['events.publish'],
      ownerAuth: {
        kind: 'lark-cli-device',
        runnerPath,
        domains: ['event', 'minutes', 'note', 'vc'],
      },
    },
    instance: {
      pluginInstanceId: 'pi_official',
      pluginId: 'official.feishu-meeting-intake',
      packageDigest: 'sha512-test',
      lifecycleState: 'installed',
      configReadiness: 'ready',
      activationState: 'disabled',
      runtimeState: 'stopped',
      lifecycleRevision: 2,
      installedAt: 1,
      updatedAt: 2,
    },
  };
}

async function packageFixture(t) {
  const rootDir = await mkdtemp(join(tmpdir(), 'cat-cafe-official-auth-'));
  const absoluteRunner = join(rootDir, runnerPath);
  await mkdir(join(absoluteRunner, '..'), { recursive: true });
  await writeFile(absoluteRunner, '#!/usr/bin/env node\n');
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  let releases = 0;
  let verifications = 0;
  const pkg = {
    rootDir,
    manifest: {},
    verifyIntegrity: async () => {
      verifications += 1;
    },
    release: async () => {
      releases += 1;
    },
  };
  return {
    rootDir,
    pkg,
    counts: () => ({ releases, verifications }),
    packages: { resolveInstalledPackage: async () => pkg },
  };
}

test('checks auth through the verified package runner with fixed status arguments', async (t) => {
  const fixture = await packageFixture(t);
  const calls = [];
  const auth = new OfficialPluginAuthService({
    packages: fixture.packages,
    run: async (spec) => {
      calls.push(spec);
      return { stdout: JSON.stringify({ identity: 'user', verified: true }), stderr: '' };
    },
  });

  assert.deepEqual(await auth.status(target()), { status: 'connected' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, process.execPath);
  assert.deepEqual(calls[0].args, [join(fixture.rootDir, runnerPath), 'auth', 'status', '--json', '--verify']);
  assert.equal(calls[0].cwd, fixture.rootDir);
  assert.equal(calls[0].env.LARKSUITE_CLI_NO_UPDATE_NOTIFIER, '1');
  assert.deepEqual(fixture.counts(), { releases: 1, verifications: 1 });
});

test('accepts pretty-printed auth status after package preparation output', async (t) => {
  const fixture = await packageFixture(t);
  const auth = new OfficialPluginAuthService({
    packages: fixture.packages,
    run: async () => ({
      stdout: [
        'Preparing bundled lark-cli runtime...',
        JSON.stringify({ identity: 'user', verified: true }, null, 2),
      ].join('\n'),
      stderr: '',
    }),
  });

  assert.deepEqual(await auth.status(target()), { status: 'connected' });
  assert.deepEqual(fixture.counts(), { releases: 1, verifications: 1 });
});

test('keeps device code server-side while completing the exact domain login', async (t) => {
  const fixture = await packageFixture(t);
  const calls = [];
  const auth = new OfficialPluginAuthService({
    packages: fixture.packages,
    toQrDataUrl: async (url) => `data:image/png;base64,${Buffer.from(url).toString('base64')}`,
    run: async (spec) => {
      calls.push(spec);
      if (spec.args.includes('--no-wait')) {
        return {
          stdout: JSON.stringify({
            device_code: 'server-secret-device-code',
            verification_url: 'https://accounts.feishu.cn/oauth/v1/device/verify?flow_id=opaque&user_code=ABCD-EFGH',
            user_code: 'ABCD-EFGH',
            expires_in: 600,
          }),
          stderr: '',
        };
      }
      if (spec.args.includes('status')) {
        return { stdout: JSON.stringify({ identity: 'user', verified: true }), stderr: '' };
      }
      return { stdout: JSON.stringify({ loggedIn: true }), stderr: '' };
    },
  });

  const started = await auth.start(target());
  assert.equal(started.status, 'waiting');
  assert.equal(started.userCode, 'ABCD-EFGH');
  assert.equal(started.verificationUrl.startsWith('https://accounts.feishu.cn/'), true);
  assert.equal(started.qrDataUrl.startsWith('data:image/png;base64,'), true);
  assert.equal('deviceCode' in started, false);
  assert.equal(JSON.stringify(started).includes('server-secret-device-code'), false);

  assert.deepEqual(calls[0].args, [
    join(fixture.rootDir, runnerPath),
    'auth',
    'login',
    '--domain',
    'event',
    '--domain',
    'minutes',
    '--domain',
    'note',
    '--domain',
    'vc',
    '--no-wait',
    '--json',
  ]);
  assert.deepEqual(calls[1].args, [
    join(fixture.rootDir, runnerPath),
    'auth',
    'login',
    '--device-code',
    'server-secret-device-code',
    '--json',
  ]);

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await auth.status(target()), { status: 'connected' });
  assert.deepEqual(fixture.counts(), { releases: 2, verifications: 2 });
  await auth.shutdown();
});

test('rejects non-Feishu verification URLs and releases the staged package', async (t) => {
  const fixture = await packageFixture(t);
  const auth = new OfficialPluginAuthService({
    packages: fixture.packages,
    run: async () => ({
      stdout: JSON.stringify({
        device_code: 'server-secret-device-code',
        verification_url: 'https://attacker.example/device',
      }),
      stderr: '',
    }),
  });

  await assert.rejects(() => auth.start(target()), /unexpected verification URL/);
  assert.deepEqual(fixture.counts(), { releases: 1, verifications: 1 });
  await auth.shutdown();
});
