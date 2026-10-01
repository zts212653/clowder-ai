import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ensurePrivateDirectory } from '@cat-cafe/shared/node-private-fs';
import { LocalCollectiveServiceManager } from '../src/domains/plugin/builtin-runtime/local-collective-service-manager.js';

test('returns a healthy same-identity Service when its competing real child fails to bind', async () => {
  const dataDirectory = join(tmpdir(), `collective-startup-competing-${randomUUID()}`);
  await ensurePrivateDirectory(dataDirectory);
  const port = await new Promise<number>((resolvePort, rejectPort) => {
    const server = createServer();
    server.once('error', rejectPort);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      server.close((error) => (error ? rejectPort(error) : resolvePort(address.port)));
    });
  });
  const serviceUrl = `http://127.0.0.1:${port}`;
  const children: ChildProcess[] = [];
  let diagnostic: { pid: number; launchId: string; status: string; code: string } | undefined;
  const manager = new LocalCollectiveServiceManager({
    env: { PATH: process.env.PATH },
    dataDirectory,
    frontendBaseUrl: 'http://127.0.0.1:55219',
    serviceUrl,
    cliPath: resolve(fileURLToPath(new URL('../../..', import.meta.url)), 'packages/collective-service/dist/cli.js'),
    spawnProcess: async (spec) => {
      const launchChild = async (launchId: string) => {
        const child = spawn(spec.command, [...spec.args], {
          env: { ...spec.env, COLLECTIVE_SERVICE_LAUNCH_ID: launchId },
          stdio: 'ignore',
          windowsHide: true,
        });
        children.push(child);
        await new Promise<void>((resolveSpawn, rejectSpawn) => {
          child.once('spawn', resolveSpawn);
          child.once('error', rejectSpawn);
        });
        return child;
      };
      await launchChild('competing-winner');
      let healthy = false;
      for (let attempt = 0; attempt < 150; attempt += 1) {
        try {
          healthy = (await fetch(`${serviceUrl}/api/health`)).ok;
        } catch {
          healthy = false;
        }
        if (healthy) break;
        await new Promise((done) => setTimeout(done, 100));
      }
      assert.equal(healthy, true, 'competing real Service must be listening before our child binds');
      const loser = await launchChild(spec.env.COLLECTIVE_SERVICE_LAUNCH_ID);
      await new Promise<void>((done) => {
        if (loser.exitCode !== null) done();
        else loser.once('exit', () => done());
      });
      assert.equal(loser.exitCode, 1);
      diagnostic = JSON.parse(await readFile(join(dataDirectory, 'collective-service-startup.json'), 'utf8'));
      assert.equal(diagnostic?.pid, loser.pid);
      assert.equal(diagnostic?.launchId, spec.env.COLLECTIVE_SERVICE_LAUNCH_ID);
      assert.equal(diagnostic?.status, 'failed');
      assert.equal(diagnostic?.code, 'STARTUP_FAILED');
      assert.ok(loser.pid);
      return { pid: loser.pid };
    },
  });
  try {
    assert.equal((await manager.status()).state, 'not_created');
    const launch = await manager.provision();
    assert.equal(launch.service.state, 'setup_required');
    assert.equal(launch.service.setupStep, 'github_app');
    assert.equal(launch.service.bootstrapNeeded, true);
    const stored = JSON.parse(await readFile(join(dataDirectory, 'collective-service.json'), 'utf8'));
    assert.equal(launch.service.serviceInstanceId, stored.serviceInstanceId);
    assert.match(launch.launchUrl, /#bootstrap=/);
    assert.equal((await fetch(`${serviceUrl}/api/health`)).status, 200);
    assert.equal((await manager.status()).state, 'setup_required');
    assert.deepEqual(
      JSON.parse(await readFile(join(dataDirectory, 'collective-service-startup.json'), 'utf8')),
      diagnostic,
    );
  } finally {
    for (const child of children) {
      if (child.exitCode !== null) continue;
      const stopped = new Promise<void>((done) => child.once('exit', () => done()));
      child.kill('SIGTERM');
      await stopped;
    }
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

for (const boundary of ['identity-mismatch', 'health-unavailable', 'missing-link', 'private-file-error']) {
  test(`matching child diagnostics do not bypass ${boundary}`, async () => {
    const dataDirectory = join(tmpdir(), `collective-startup-boundary-${randomUUID()}`);
    await ensurePrivateDirectory(dataDirectory);
    const statePath = join(dataDirectory, 'collective-service.json');
    const state = '{"serviceInstanceId":"svc_preserved"}\n';
    await writeFile(statePath, state, { mode: 0o600 });
    let started = false;
    const manager = new LocalCollectiveServiceManager({
      dataDirectory,
      env: {},
      frontendBaseUrl: 'http://localhost:5102',
      serviceUrl: 'http://127.0.0.1:55231',
      cliPath: 'fixture-cli',
      fetchImpl: async (input) => {
        if (!started || boundary === 'health-unavailable') throw new Error('offline fixture');
        return String(input).endsWith('/api/health')
          ? Response.json({
              ok: true,
              serviceInstanceId: boundary === 'identity-mismatch' ? 'svc_foreign' : 'svc_preserved',
              bootstrapNeeded: boundary === 'missing-link',
              onboardingComplete: boundary !== 'missing-link',
            })
          : Response.json({ providers: [{ id: 'github', ready: true }] });
      },
      spawnProcess: async (spec) => {
        started = true;
        const diagnosticPath = join(dataDirectory, 'collective-service-startup.json');
        if (boundary === 'private-file-error') await mkdir(diagnosticPath);
        else
          await writeFile(
            diagnosticPath,
            JSON.stringify({
              pid: 90009,
              launchId: spec.env.COLLECTIVE_SERVICE_LAUNCH_ID,
              status: 'failed',
              code: 'BOOTSTRAP_UNRECOVERABLE',
            }),
            { mode: 0o600 },
          );
        return { pid: 90009 };
      },
    });
    try {
      await assert.rejects(
        manager.provision(),
        boundary === 'identity-mismatch'
          ? /different Collective Service/
          : boundary === 'private-file-error'
            ? /private regular file/
            : /bootstrap_unrecoverable/,
      );
      assert.equal(await readFile(statePath, 'utf8'), state);
    } finally {
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });
}

test('residual damaged diagnostics do not block healthy children across repeated starts', async () => {
  const dataDirectory = join(tmpdir(), `collective-startup-damaged-${randomUUID()}`);
  await ensurePrivateDirectory(dataDirectory);
  const state = '{"serviceInstanceId":"svc_preserved"}\n';
  await writeFile(join(dataDirectory, 'collective-service.json'), state, { mode: 0o600 });
  const damaged = '{"secret":"fixture-secret';
  const diagnosticPath = join(dataDirectory, 'collective-service-startup.json');
  await writeFile(diagnosticPath, damaged, { mode: 0o600 });
  try {
    for (let restart = 0; restart < 2; restart += 1) {
      let online = false;
      let waits = 0;
      const manager = new LocalCollectiveServiceManager({
        dataDirectory,
        env: {},
        frontendBaseUrl: 'http://localhost:5102',
        serviceUrl: 'http://127.0.0.1:55231',
        cliPath: 'fixture-cli',
        fetchImpl: async (input) => {
          if (!online) throw new Error('offline fixture');
          return String(input).endsWith('/api/health')
            ? Response.json({
                ok: true,
                serviceInstanceId: 'svc_preserved',
                bootstrapNeeded: false,
                onboardingComplete: true,
              })
            : Response.json({ providers: [{ id: 'github', ready: true }] });
        },
        spawnProcess: async () => ({ pid: 90003 + restart }),
        wait: async () => {
          waits += 1;
          online = true;
        },
      });
      const launch = await manager.provision();
      assert.equal(launch.service.state, 'ready');
      assert.equal(launch.launchUrl, 'http://127.0.0.1:55231');
      assert.equal(waits, 1);
      assert.equal(await readFile(diagnosticPath, 'utf8'), damaged);
      assert.equal(await readFile(join(dataDirectory, 'collective-service.json'), 'utf8'), state);
    }
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

for (const initialDiagnostic of ['stale', 'damaged']) {
  test(`managed startup ignores ${initialDiagnostic} diagnostics and reports the matching child failure`, async () => {
    const dataDirectory = join(tmpdir(), `collective-startup-failure-${randomUUID()}`);
    await ensurePrivateDirectory(dataDirectory);
    let waits = 0;
    let launchId: string | undefined;
    const state = '{"serviceInstanceId":"svc_preserved"}\n';
    await writeFile(join(dataDirectory, 'collective-service.json'), state, { mode: 0o600 });
    const manager = new LocalCollectiveServiceManager({
      dataDirectory,
      env: {},
      frontendBaseUrl: 'http://localhost:5102',
      serviceUrl: 'http://127.0.0.1:55231',
      cliPath: 'fixture-cli',
      fetchImpl: async () => {
        throw new Error('offline fixture');
      },
      spawnProcess: async (spec) => {
        launchId = spec.env.COLLECTIVE_SERVICE_LAUNCH_ID;
        await writeFile(
          join(dataDirectory, 'collective-service-startup.json'),
          initialDiagnostic === 'damaged'
            ? '{'
            : JSON.stringify({
                pid: 90002,
                launchId: 'stale-launch',
                status: 'failed',
                code: 'BOOTSTRAP_UNRECOVERABLE',
              }),
          { mode: 0o600 },
        );
        return { pid: 90002 };
      },
      wait: async () => {
        waits += 1;
        await writeFile(
          join(dataDirectory, 'collective-service-startup.json'),
          JSON.stringify({ pid: 90002, launchId, status: 'failed', code: 'BOOTSTRAP_UNRECOVERABLE' }),
        );
      },
    });
    try {
      await assert.rejects(manager.provision(), /bootstrap_unrecoverable/);
      assert.equal(waits, 1, 'unattributable record is ignored; matching failure stops the next poll');
      assert.equal(await readFile(join(dataDirectory, 'collective-service.json'), 'utf8'), state);
    } finally {
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });
}
