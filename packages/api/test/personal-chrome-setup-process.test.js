import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runChromeSetupProcess } from '../dist/domains/plugin/manager/chrome-setup/personal-chrome-setup-process.js';

async function fixture(source, overrides = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'chrome-setup-runner-')));
  const entrypoint = join(root, 'runner.mjs');
  await writeFile(entrypoint, source);
  return {
    root,
    input: {
      entrypoint,
      projectRoot: root,
      home: root,
      action: 'inspect',
      signal: new AbortController().signal,
      assertCurrent: async () => {},
      ...overrides,
    },
  };
}

test('fixed runner uses explicit HOME/args and a minimal environment, without a shell', async () => {
  const f = await fixture(
    'console.log(JSON.stringify({args:process.argv.slice(2),env:process.env,cwd:process.cwd()}));',
  );
  const result = await runChromeSetupProcess(f.input);
  assert.deepEqual(result.args, [
    'inspect',
    '--json',
    '--project-root',
    f.root,
    '--home',
    f.root,
    '--node',
    process.execPath,
  ]);
  assert.equal(result.cwd, f.root);
  assert.equal(result.env.HOME, f.root);
  const expectedKeys = ['HOME', 'LANG', 'NODE_ENV', 'PATH'];
  if (process.env.CAT_CAFE_PUBLIC_TEST_RESOURCE_SCOPE === 'distributable') {
    assert.equal(result.env.CAT_CAFE_PUBLIC_TEST_RESOURCE_SCOPE, 'distributable');
    assert.equal(result.env.GIT_ALLOW_PROTOCOL, 'file');
    assert.ok(process.env.NODE_OPTIONS?.includes('--import='));
    assert.equal(result.env.NODE_OPTIONS, process.env.NODE_OPTIONS);
    expectedKeys.push('CAT_CAFE_PUBLIC_TEST_RESOURCE_SCOPE', 'GIT_ALLOW_PROTOCOL', 'NODE_OPTIONS');
  }
  assert.deepEqual(
    Object.keys(result.env)
      .filter((key) => !['__CF_USER_TEXT_ENCODING', 'SystemRoot', 'SYSTEMROOT'].includes(key))
      .sort(),
    expectedKeys.sort(),
  );
});

for (const [label, source] of [
  ['multiple JSON', 'console.log("{}\\n{}");'],
  ['crash', 'process.exit(7);'],
  ['oversized stdout', 'process.stdout.write("x".repeat(70000)); setInterval(()=>{},100);'],
  ['oversized stderr', 'process.stderr.write("x".repeat(70000)); setInterval(()=>{},100);'],
])
  test(`runner rejects ${label}`, async () => {
    const f = await fixture(source);
    await assert.rejects(runChromeSetupProcess(f.input), /SETUP_(RUNNER_FAILED|PROTOCOL_INVALID)/);
  });

for (const reason of ['timeout', 'disconnect', 'revocation'])
  test(`runner waits for child close after ${reason}`, async () => {
    const controller = new AbortController();
    let revoked = false;
    const f = await fixture(
      `import {writeFileSync} from 'node:fs';
    process.on('SIGTERM',()=>{ setTimeout(()=>{writeFileSync('closed.txt','closed');process.exit(0)},50) });
    writeFileSync('ready.txt',String(process.pid)); setInterval(()=>{},100);`,
      {
        signal: controller.signal,
        timeoutMs: reason === 'timeout' ? 500 : 3000,
        assertCurrent: async () => {
          if (revoked) throw new Error('session revoked');
        },
      },
    );
    const pending = runChromeSetupProcess(f.input);
    // Observe this test child's startup, without touching a running application.
    for (let i = 0; i < 100; i++) {
      if (
        await readFile(join(f.root, 'ready.txt')).then(
          () => true,
          () => false,
        )
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (reason === 'disconnect') controller.abort();
    if (reason === 'revocation') revoked = true;
    await assert.rejects(pending, /SETUP_RUNNER_FAILED/);
    if (process.platform !== 'win32') assert.equal(await readFile(join(f.root, 'closed.txt'), 'utf8'), 'closed');
    const childPid = Number(await readFile(join(f.root, 'ready.txt'), 'utf8'));
    assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' });
  });

test('already revoked authority never starts the runner', async () => {
  const f = await fixture('throw new Error("must not run")', {
    assertCurrent: async () => {
      throw new Error('revoked');
    },
  });
  await assert.rejects(runChromeSetupProcess(f.input), /revoked/);
});
