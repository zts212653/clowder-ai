import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runNodePublicTestFile } from '../scripts/run-public-test-shard.mjs';
import { reportSystemSshRunnerInputs } from './helpers/system-ssh-runner-inputs.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ssh-runner-diagnostic-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'system-ssh');
  mkdirSync(join(directory, 'ssh_config.d'), { recursive: true });
  writeFileSync(join(directory, 'ssh_config'), `Include ${directory}/ssh_config.d/*.conf\n`);
  writeFileSync(join(directory, 'ssh_config.d', '20-systemd.conf'), 'Host unix/* unix%*\n ProxyCommand false\n');
  return { root, directory };
}

test('system diagnostics recognize public shard context without relying on a GitHub variable', (t) => {
  const { directory } = fixture(t);
  for (const env of [
    { GITHUB_ACTIONS: 'true' },
    { CAT_CAFE_PUBLIC_TEST_RESOURCE_SCOPE: 'distributable' },
    { CAT_CAFE_PUBLIC_TEST_RESOURCE_SCOPE: 'shared', GITHUB_ACTIONS: 'false' },
  ]) {
    const messages = [];
    reportSystemSshRunnerInputs(
      { diagnostic: (value) => messages.push(JSON.parse(value)) },
      {
        platform: 'linux',
        env,
        directory,
      },
    );
    assert.equal(messages.length, 1, JSON.stringify(env));
    assert.equal(messages[0].kind, 'system_ssh_runner_inputs');
    assert.equal(messages[0].context.inputKind, 'test_fixture');
    assert.deepEqual(messages[0].scope, { complete: true, port: 22 });
    assert.equal(messages[0].files.length, 2);
  }
  for (const [platform, env] of [
    ['linux', {}],
    ['linux', { CAT_CAFE_PUBLIC_TEST_RESOURCE_SCOPE: 'unknown' }],
    ['darwin', { GITHUB_ACTIONS: 'true', CAT_CAFE_PUBLIC_TEST_RESOURCE_SCOPE: 'distributable' }],
    ['win32', { GITHUB_ACTIONS: 'true' }],
  ])
    reportSystemSshRunnerInputs(
      { diagnostic: () => assert.fail('unrequested system read') },
      {
        platform,
        env,
        directory: join(directory, 'must-not-read'),
      },
    );
});

test('the actual per-file public runner forwards a bounded diagnostic from its child context', async (t) => {
  const { root, directory } = fixture(t);
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'test/helpers'), { recursive: true });
  // The minimal package has no application build prerequisite. Its real
  // resource guard and per-file runner still own the child boundary/stdout.
  writeFileSync(
    join(root, 'scripts/public-test-external-resource-guard.mjs'),
    readFileSync(new URL('../scripts/public-test-external-resource-guard.mjs', import.meta.url)),
  );
  writeFileSync(join(root, 'test/helpers/setup-cat-registry.js'), '');
  const helper = new URL('./helpers/system-ssh-runner-inputs.js', import.meta.url).href;
  writeFileSync(
    join(root, 'test/diagnostic.test.mjs'),
    [
      "import { test } from 'node:test';",
      `import { reportSystemSshRunnerInputs } from ${JSON.stringify(helper)};`,
      // Exercise the Linux selection branch on every OS; this is a fixture,
      // never a claim about a real Linux runner or this host's /etc/ssh.
      `test('runner diagnostic', t => reportSystemSshRunnerInputs(t, { platform: 'linux', directory: ${JSON.stringify(directory)} }));`,
    ].join('\n'),
  );
  const result = await runNodePublicTestFile({
    file: 'test/diagnostic.test.mjs',
    packageRoot: root,
    resourceScope: 'distributable',
    env: { PATH: process.env.PATH, HOME: root, GITHUB_ACTIONS: '' },
  });
  assert.equal(result.status, 'passed', result.outputTail);
  const diagnostic = result.outputTail.split('\n').find((line) => line.includes('"kind":"system_ssh_runner_inputs"'));
  assert.ok(diagnostic, 'successful child stdout must contain the bounded system diagnostic');
  const message = JSON.parse(diagnostic.slice(diagnostic.indexOf('{')));
  assert.deepEqual(message.scope, { complete: true, port: 22 });
  assert.equal(message.files.length, 2);
  assert.equal(message.context.inputKind, 'test_fixture');
});
