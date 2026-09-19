import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertDistributableCommand, assertDistributableUrl } from '../scripts/public-test-external-resource-guard.mjs';

const LOCAL_COMMAND_FIXTURES_ENV = 'CAT_CAFE_PUBLIC_TEST_LOCAL_COMMAND_FIXTURES';

function withLocalCommandFixtures(value, run) {
  const original = process.env[LOCAL_COMMAND_FIXTURES_ENV];
  process.env[LOCAL_COMMAND_FIXTURES_ENV] = value;
  try {
    return run();
  } finally {
    if (original === undefined) delete process.env[LOCAL_COMMAND_FIXTURES_ENV];
    else process.env[LOCAL_COMMAND_FIXTURES_ENV] = original;
  }
}

describe('F308 public-test external resource guard', () => {
  it('allows process-local endpoints and local filesystem git transports', () => {
    for (const value of [
      'http://127.0.0.1:3004/health',
      'http://localhost:3004/health',
      'ws://[::1]:9876/socket',
      'file:///tmp/fixture.json',
    ]) {
      assert.doesNotThrow(() => assertDistributableUrl(value, 'fixture'));
    }
    assert.doesNotThrow(() => assertDistributableCommand('git', ['fetch', '/tmp/repo.git', 'main']));
    assert.doesNotThrow(() => assertDistributableCommand('git', ['push', 'origin', 'main']));
    assert.doesNotThrow(() => assertDistributableCommand('curl', ['http://127.0.0.1:3004/health']));
  });

  it('rejects real non-loopback endpoints and network-capable commands before I/O', () => {
    assert.throws(
      () => assertDistributableUrl('https://api.github.com/repos/zts212653/clowder-ai', 'fetch'),
      /external_resource_violation/,
    );
    assert.throws(() => assertDistributableCommand('gh', ['api', '/repos/a/b']), /external_resource_violation/);
    assert.throws(
      () => assertDistributableCommand('curl', ['https://example.com/fixture']),
      /external_resource_violation/,
    );
    assert.throws(
      () => assertDistributableCommand('sh', ['-c', 'wget https://example.com/fixture']),
      /external_resource_violation/,
    );
    assert.throws(
      () => assertDistributableCommand('bash', ['-c', 'echo >/dev/tcp/198.51.100.1/9']),
      /external_resource_violation/,
      'Bash pseudo-device TCP redirection must fail before the child is spawned',
    );
    assert.throws(
      () => assertDistributableCommand('bash', ['-c', 'echo >/dev/udp/example.com/53']),
      /external_resource_violation/,
      'Bash pseudo-device UDP redirection must fail before the child is spawned',
    );
    assert.throws(
      () => assertDistributableCommand('bash', ['-c', 'echo >/dev/tcp/$TARGET_HOST/9']),
      /external_resource_violation/,
      'dynamic Bash pseudo-device targets are not provably loopback',
    );
    assert.throws(
      () => assertDistributableCommand('git', ['ls-remote', 'https://example.com/repo.git']),
      /external_resource_violation/,
    );
  });

  it('allows an explicit loopback Git probe without opening Git access to remote hosts', () => {
    const guardPath = fileURLToPath(new URL('../scripts/public-test-external-resource-guard.mjs', import.meta.url));
    const script = [
      'const { execFile } = await import("node:child_process");',
      'execFile("git", ["ls-remote", "https://127.0.0.1:1/nonexistent.git"], (error, _stdout, stderr) => {',
      '  if (!error) process.exit(2);',
      '  if (/transport .https. not allowed/i.test(stderr)) process.exit(3);',
      '  process.exit(/failed to connect|connection refused/i.test(stderr) ? 0 : 4);',
      '});',
    ].join('');
    const result = spawnSync(process.execPath, ['--import', guardPath, '--eval', script], {
      encoding: 'utf8',
      env: { ...process.env, CAT_CAFE_PUBLIC_TEST_RESOURCE_SCOPE: 'distributable' },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });

  it('does not confuse fixture strings or harmless local commands with external use', () => {
    assert.doesNotThrow(() => assertDistributableCommand('node', ['-e', 'console.log("gh ssh curl")']));
    assert.doesNotThrow(() => assertDistributableCommand('git', ['status', '--short']));
    assert.doesNotThrow(() => assertDistributableCommand('sh', ['-c', 'printf "gh ssh curl"']));
    assert.doesNotThrow(() => assertDistributableCommand('bash', ['-c', 'echo >/dev/tcp/127.0.0.1/9']));
  });

  it('binds local command fixture declarations to one exact temporary executable', () => {
    const root = mkdtempSync(join(tmpdir(), 'cat-cafe-public-test-command-'));
    const declaredDirectory = join(root, 'declared');
    const undeclaredDirectory = join(root, 'undeclared');
    const escapedDirectory = join(root, 'escaped');
    mkdirSync(declaredDirectory);
    mkdirSync(undeclaredDirectory);
    mkdirSync(escapedDirectory);
    const declaredGh = join(declaredDirectory, 'gh');
    const undeclaredGh = join(undeclaredDirectory, 'gh');
    const escapedGh = join(escapedDirectory, 'gh');
    writeFileSync(declaredGh, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(undeclaredGh, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    symlinkSync(process.execPath, escapedGh);

    try {
      withLocalCommandFixtures(declaredGh, () => {
        assert.doesNotThrow(() =>
          assertDistributableCommand('gh', ['api', '/repos/a/b'], { env: { PATH: declaredDirectory } }),
        );
        assert.throws(
          () => assertDistributableCommand('gh', ['api', '/repos/a/b'], { env: { PATH: undeclaredDirectory } }),
          /external_resource_violation/,
          'declaring one fixture must not authorize another executable with the same basename',
        );
        assert.throws(
          () =>
            assertDistributableCommand('sh', ['-c', `${declaredGh} && curl https://example.com/fixture`], {
              env: { PATH: declaredDirectory },
            }),
          /external_resource_violation/,
          'a declared fixture must not authorize a sibling shell command',
        );
      });
      withLocalCommandFixtures(escapedGh, () => {
        assert.throws(
          () => assertDistributableCommand('gh', ['api', '/repos/a/b'], { env: { PATH: escapedDirectory } }),
          /external_resource_violation/,
          'a temporary symlink must not authorize a real executable outside the temporary root',
        );
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('blocks a real external fetch in a guarded child before network I/O', () => {
    const guardPath = fileURLToPath(new URL('../scripts/public-test-external-resource-guard.mjs', import.meta.url));
    const result = spawnSync(
      process.execPath,
      ['--import', guardPath, '--eval', 'await fetch("https://example.com/should-not-run")'],
      {
        encoding: 'utf8',
        env: { ...process.env, CAT_CAFE_PUBLIC_TEST_RESOURCE_SCOPE: 'distributable' },
      },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /external_resource_violation/);
  });

  it('propagates the guard through allowed children that replace their environment', () => {
    const guardPath = fileURLToPath(new URL('../scripts/public-test-external-resource-guard.mjs', import.meta.url));
    const childScript = [
      'const { spawnSync } = await import("node:child_process");',
      'const nestedCode = [',
      '  "if (process.env.CAT_CAFE_PUBLIC_TEST_RESOURCE_SCOPE !== \\\"distributable\\\") process.exit(3);",',
      '  "if (process.env.GIT_ALLOW_PROTOCOL !== \\\"file\\\") process.exit(4);",',
      '  "await fetch(\\\"https://example.com/should-not-run\\\");",',
      '].join("");',
      'const nested = spawnSync(process.execPath, ["--eval", nestedCode], {',
      '  encoding: "utf8",',
      '  env: {',
      '    CAT_CAFE_PUBLIC_TEST_RESOURCE_SCOPE: "",',
      '    GIT_ALLOW_PROTOCOL: "https",',
      '    NODE_OPTIONS: "",',
      '  },',
      '});',
      'if (nested.status === 0 || !/external_resource_violation/.test(nested.stderr)) process.exit(2);',
    ].join('');
    const result = spawnSync(process.execPath, ['--import', guardPath, '--eval', childScript], {
      encoding: 'utf8',
      env: { ...process.env, CAT_CAFE_PUBLIC_TEST_RESOURCE_SCOPE: 'distributable' },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });

  it('propagates the guard through the child_process options-only overload', () => {
    const guardPath = fileURLToPath(new URL('../scripts/public-test-external-resource-guard.mjs', import.meta.url));
    const childScript = [
      'const { spawnSync } = await import("node:child_process");',
      'const nested = spawnSync(process.execPath, {',
      '  encoding: "utf8",',
      '  env: {},',
      '  input: "await fetch(\\"https://example.com/should-not-run\\")",',
      '});',
      'if (nested.status === 0 || !/external_resource_violation/.test(nested.stderr)) process.exit(2);',
    ].join('');
    const result = spawnSync(process.execPath, ['--import', guardPath, '--eval', childScript], {
      encoding: 'utf8',
      env: { ...process.env, CAT_CAFE_PUBLIC_TEST_RESOURCE_SCOPE: 'distributable' },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });

  it('propagates the guard through shell-command children that replace their environment', () => {
    const guardPath = fileURLToPath(new URL('../scripts/public-test-external-resource-guard.mjs', import.meta.url));
    const childScript = [
      'const { execSync } = await import("node:child_process");',
      'const command = `${JSON.stringify(process.execPath)} -p process.env.GIT_ALLOW_PROTOCOL`;',
      'const output = execSync(command, { encoding: "utf8", env: {} });',
      'if (output.trim() !== "file") process.exit(2);',
    ].join('');
    const result = spawnSync(process.execPath, ['--import', guardPath, '--eval', childScript], {
      encoding: 'utf8',
      env: { ...process.env, CAT_CAFE_PUBLIC_TEST_RESOURCE_SCOPE: 'distributable' },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });

  it('preserves child_process promisify semantics while guarding commands', () => {
    const guardPath = fileURLToPath(new URL('../scripts/public-test-external-resource-guard.mjs', import.meta.url));
    const script = [
      'const { promisify } = await import("node:util");',
      'const { exec, execFile } = await import("node:child_process");',
      'const execAsync = promisify(exec);',
      'const execFileAsync = promisify(execFile);',
      'const expectViolation = async (run) => {',
      '  try { await run(); } catch (error) {',
      '    if (/external_resource_violation/.test(String(error))) return;',
      '    throw error;',
      '  }',
      '  process.exit(3);',
      '};',
      'await expectViolation(() => execAsync("curl https://example.com/should-not-run"));',
      'await expectViolation(() => execFileAsync("curl", ["https://example.com/should-not-run"]));',
      'const { stdout: protocol } = await execFileAsync(',
      '  process.execPath,',
      '  ["-p", "process.env.GIT_ALLOW_PROTOCOL"],',
      '  { env: {} },',
      ');',
      'if (protocol.trim() !== "file") process.exit(4);',
      'const { stdout } = await execFileAsync(process.execPath, ["--version"]);',
      'if (!stdout.startsWith("v")) process.exit(2);',
    ].join('');
    const result = spawnSync(process.execPath, ['--import', guardPath, '--eval', script], {
      encoding: 'utf8',
      env: { ...process.env, CAT_CAFE_PUBLIC_TEST_RESOURCE_SCOPE: 'distributable' },
    });
    assert.equal(result.status, 0, result.stderr);
  });
});
