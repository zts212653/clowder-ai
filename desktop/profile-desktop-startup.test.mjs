import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { readAheadApi } from './api-startup-read-ahead.mjs';
import { profileDesktopStartup } from './scripts/profile-desktop-startup.mjs';
import { createProfileSource } from './test-helpers/profile-source-fixture.mjs';

const fixtureHttpServer = `
  import { createServer } from 'node:http';
  const server = createServer((request, response) => {
    if (request.url === '/health' && request.headers['x-clowder-desktop-probe'] === '1')
      response.setHeader('x-clowder-desktop-startup-id', process.env.CAT_CAFE_DESKTOP_STARTUP_ID);
    response.end('ok');
  });
`;

test(
  'the installed profile project cannot inherit the source checkout Git repository',
  { timeout: 30000 },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-git-boundary-'));
    let trace;
    try {
      execFileSync('git', ['init', '--quiet', root], { timeout: 5000 });
      const frozen = path.join(root, 'frozen');
      await fs.mkdir(path.join(frozen, 'api/dist'), { recursive: true });
      await fs.mkdir(path.join(frozen, 'dependencies'));
      await fs.writeFile(path.join(frozen, 'api/package.json'), '{"type":"module"}');
      await fs.writeFile(
        path.join(frozen, 'api/dist/index.desktop.js'),
        `
      import fs from 'node:fs';
      ${fixtureHttpServer}
      fs.writeFileSync('git-boundary.json',JSON.stringify({cwd:process.cwd(),gitEnvKeys:Object.keys(process.env).filter(key=>key.startsWith('GIT_'))}));
      server.listen(Number(process.env.API_SERVER_PORT),'127.0.0.1',()=>globalThis.__clowderStartupMilestone('http-listening'));
    `,
      );
      const receipt = await profileDesktopStartup(await createProfileSource(root), frozen);
      trace = receipt.profileRoot;
      assert.ok((await fs.stat(receipt.manifest)).size > 0);
      const project = path.join(trace, 'instance/project');
      const boundary = JSON.parse(await fs.readFile(path.join(project, 'git-boundary.json'), 'utf8'));
      assert.equal(await fs.realpath(boundary.cwd), await fs.realpath(project));
      assert.deepEqual(boundary.gitEnvKeys, [], 'profile API must not inherit a Git environment override');
      // Probe the actual API cwd after startup: an unrelated Git process must not
      // block the synthetic API's readiness milestone or outlive the test budget.
      const git = spawnSync('git', ['rev-parse', '--show-toplevel'], {
        cwd: boundary.cwd,
        env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
        encoding: 'utf8',
        timeout: 5000,
      });
      assert.equal(git.error, undefined, 'bounded Git discovery must execute successfully');
      assert.equal(git.status, 128, 'installed profile inherited a Git repository');
      assert.match(git.stderr, /not a git repository/i);
    } finally {
      if (trace && !trace.startsWith(root + path.sep)) await fs.rm(trace, { recursive: true, force: true });
      // Synthetic HTTP fixture only; no persistent database or agent session.
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'build trace uses an isolated API, produces portable program hints and releases its port',
  { timeout: 30000 },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-build-profile-'));
    const frozen = path.join(root, 'frozen');
    const entry = path.join(frozen, 'api/dist/index.desktop.js');
    try {
      await fs.mkdir(path.dirname(entry), { recursive: true });
      await fs.mkdir(path.join(frozen, 'dependencies'));
      await fs.writeFile(path.join(frozen, 'api/package.json'), '{"type":"module"}');
      const code = `import "../scripts/startup-helper.mjs"; ${fixtureHttpServer} server.listen(Number(process.env.API_SERVER_PORT),"127.0.0.1",()=>globalThis.__clowderStartupMilestone("http-listening"));`;
      await fs.mkdir(path.join(frozen, 'api/scripts'));
      await fs.writeFile(path.join(frozen, 'api/scripts/startup-helper.mjs'), 'export const value = 1;');
      await fs.writeFile(entry, code);
      const sourceRoot = await createProfileSource(root);
      const receipt = await profileDesktopStartup(sourceRoot, frozen, { profileRoot: path.join(root, 'trace') });
      const manifest = JSON.parse(await fs.readFile(receipt.manifest, 'utf8'));
      assert.equal(manifest.entrySha256, createHash('sha256').update(code).digest('hex'));
      assert.deepEqual(manifest.files, [
        { relative: 'packages/api/dist/index.desktop.js', bytes: Buffer.byteLength(code) },
      ]);
      assert.equal(JSON.stringify(manifest).includes(root), false);
      assert.equal(manifest.excludedFiles, 1);
      assert.equal(
        await fetch(`http://127.0.0.1:${receipt.apiPort}`, { signal: AbortSignal.timeout(500) }).then(
          () => true,
          () => false,
        ),
        false,
      );
      const installed = path.join(root, 'trace/app/packages/api/dist/index.desktop.js');
      await fs.copyFile(receipt.manifest, path.join(path.dirname(installed), '.startup-read-ahead.json'));
      assert.equal((await readAheadApi(installed)).status, 'ready');
    } finally {
      // This test starts only a synthetic HTTP module; it creates no DB or model sessions.
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'a hung build API fails with retained diagnostics and no surviving child or manifest',
  { timeout: 15000 },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-profile-fault-'));
    const frozen = path.join(root, 'frozen');
    const trace = path.join(root, 'trace');
    const entry = path.join(frozen, 'api/dist/index.desktop.js');
    try {
      await fs.mkdir(path.dirname(entry), { recursive: true });
      await fs.mkdir(path.join(frozen, 'dependencies'));
      await fs.writeFile(path.join(frozen, 'api/package.json'), '{"type":"module"}');
      await fs.writeFile(
        entry,
        'import fs from "node:fs"; fs.writeFileSync("fixture-pid",String(process.pid)); setInterval(()=>{},100);',
      );
      await assert.rejects(
        profileDesktopStartup(await createProfileSource(root), frozen, { profileRoot: trace, timeoutMs: 3000 }),
        /profile failed/,
      );
      const pid = Number(await fs.readFile(path.join(trace, 'instance/project/fixture-pid'), 'utf8'));
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
      assert.ok((await fs.stat(path.join(trace, 'build.log'))).size > 0);
      await assert.rejects(fs.stat(path.join(frozen, 'api/dist/.startup-read-ahead.json')), { code: 'ENOENT' });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

test('a failed frozen API exposes its root cause and the retained log location', { timeout: 15000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-profile-exit-'));
  const frozen = path.join(root, 'frozen');
  const trace = path.join(root, 'trace');
  const entry = path.join(frozen, 'api/dist/index.desktop.js');
  try {
    await fs.mkdir(path.dirname(entry), { recursive: true });
    await fs.mkdir(path.join(frozen, 'dependencies'));
    await fs.writeFile(path.join(frozen, 'api/package.json'), '{"type":"module"}');
    await fs.writeFile(entry, 'console.error("PR1519_PROFILE_ROOT_CAUSE"); process.exit(42);');
    await assert.rejects(
      profileDesktopStartup(await createProfileSource(root), frozen, { profileRoot: trace }),
      (error) => {
        assert.ok(error.message.includes(path.join(trace, 'build.log')), 'Missing retained diagnostic path');
        assert.ok(error.message.includes('PR1519_PROFILE_ROOT_CAUSE'), 'Missing actual child failure');
        return true;
      },
    );
  } finally {
    // Only a synthetic exiting module was started; no persistent databases exist.
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('an open API port cannot substitute for its completed startup trace', { timeout: 15000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-profile-delayed-trace-'));
  const frozen = path.join(root, 'frozen');
  const trace = path.join(root, 'trace');
  const entry = path.join(frozen, 'api/dist/index.desktop.js');
  try {
    await fs.mkdir(path.dirname(entry), { recursive: true });
    await fs.mkdir(path.join(frozen, 'dependencies'));
    await fs.writeFile(path.join(frozen, 'api/package.json'), '{"type":"module"}');
    await fs.writeFile(
      entry,
      `${fixtureHttpServer} server.listen(Number(process.env.API_SERVER_PORT),"127.0.0.1",()=>setTimeout(()=>globalThis.__clowderStartupMilestone("http-listening"),1200));`,
    );
    const receipt = await profileDesktopStartup(await createProfileSource(root), frozen, { profileRoot: trace });
    assert.ok((await fs.stat(receipt.manifest)).size > 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a listening API without a completion milestone still times out and exits', { timeout: 15000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-profile-no-trace-'));
  const frozen = path.join(root, 'frozen');
  const trace = path.join(root, 'trace');
  const entry = path.join(frozen, 'api/dist/index.desktop.js');
  try {
    await fs.mkdir(path.dirname(entry), { recursive: true });
    await fs.mkdir(path.join(frozen, 'dependencies'));
    await fs.writeFile(path.join(frozen, 'api/package.json'), '{"type":"module"}');
    await fs.writeFile(
      entry,
      `import fs from "node:fs"; ${fixtureHttpServer} server.listen(Number(process.env.API_SERVER_PORT),"127.0.0.1",()=>fs.writeFileSync("fixture-pid",String(process.pid)));`,
    );
    await assert.rejects(
      profileDesktopStartup(await createProfileSource(root), frozen, { profileRoot: trace, timeoutMs: 3000 }),
      /profile failed/,
    );
    const pid = Number(await fs.readFile(path.join(trace, 'instance/project/fixture-pid'), 'utf8'));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    await assert.rejects(fs.stat(path.join(frozen, 'api/dist/.startup-read-ahead.json')), { code: 'ENOENT' });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
