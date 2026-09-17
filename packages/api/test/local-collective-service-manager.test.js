import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { LocalCollectiveServiceManager } from '../dist/domains/plugin/builtin-runtime/local-collective-service-manager.js';

const REPO_ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));

function offlineFetch() {
  throw new TypeError('fetch failed');
}

test('provisions the local Service and returns its one-time bootstrap link only from the owner mutation', async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'collective-service-manager-'));
  const starts = [];
  let online = false;
  const manager = new LocalCollectiveServiceManager({
    env: { HOME: dataDirectory },
    dataDirectory,
    frontendBaseUrl: 'http://localhost:3003',
    serviceUrl: 'http://127.0.0.1:55201',
    cliPath: '/app/collective-service/cli.js',
    fetchImpl: async (input) => {
      if (!online) return offlineFetch();
      const url = String(input);
      if (url.endsWith('/api/health')) {
        return Response.json({
          ok: true,
          serviceInstanceId: 'svc_local',
          bootstrapNeeded: true,
          onboardingComplete: false,
        });
      }
      return Response.json({ providers: [{ id: 'github', ready: false, setupSupported: true }] });
    },
    spawnProcess: async (spec) => {
      starts.push(spec);
      await mkdir(dataDirectory, { recursive: true });
      await writeFile(join(dataDirectory, 'collective-service.json'), '{"serviceInstanceId":"svc_local"}\n');
      await writeFile(
        join(dataDirectory, 'owner-bootstrap.url'),
        'http://127.0.0.1:55201/#bootstrap=one-time-owner-secret\n',
      );
      online = true;
      return { pid: 41001 };
    },
    wait: async () => undefined,
  });

  assert.deepEqual(await manager.status(), {
    state: 'not_created',
    serviceUrl: 'http://127.0.0.1:55201',
    dataDirectory,
  });
  const provisioned = await manager.provision();
  assert.equal(provisioned.launchUrl, 'http://127.0.0.1:55201/#bootstrap=one-time-owner-secret');
  assert.deepEqual(provisioned.service, {
    state: 'setup_required',
    serviceUrl: 'http://127.0.0.1:55201',
    dataDirectory,
    serviceInstanceId: 'svc_local',
    bootstrapNeeded: true,
    setupStep: 'github_app',
  });
  assert.equal(starts.length, 1);
  assert.equal(starts[0].command, process.execPath);
  assert.deepEqual(starts[0].args, ['/app/collective-service/cli.js']);
  assert.equal(starts[0].env.COLLECTIVE_SERVICE_ALLOWED_HOST_ORIGINS, 'http://localhost:3003');
  assert.equal(JSON.stringify(await manager.status()).includes('one-time-owner-secret'), false);
});

test('waits for the one-time bootstrap file when health becomes ready before the CLI writes it', async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'collective-service-manager-bootstrap-race-'));
  let online = false;
  let waits = 0;
  const manager = new LocalCollectiveServiceManager({
    env: { HOME: dataDirectory },
    dataDirectory,
    frontendBaseUrl: 'http://localhost:3003',
    serviceUrl: 'http://127.0.0.1:55204',
    cliPath: '/app/collective-service/cli.js',
    fetchImpl: async (input) => {
      if (!online) return offlineFetch();
      return String(input).endsWith('/api/health')
        ? Response.json({
            ok: true,
            serviceInstanceId: 'svc_race',
            bootstrapNeeded: true,
            onboardingComplete: false,
          })
        : Response.json({ providers: [{ id: 'github', ready: false, setupSupported: true }] });
    },
    spawnProcess: async () => {
      await writeFile(join(dataDirectory, 'collective-service.json'), '{"serviceInstanceId":"svc_race"}\n');
      online = true;
      return { pid: 41004 };
    },
    wait: async () => {
      waits += 1;
      await writeFile(join(dataDirectory, 'owner-bootstrap.url'), 'http://127.0.0.1:55204/#bootstrap=late-secret\n');
    },
  });

  try {
    assert.equal((await manager.provision()).launchUrl, 'http://127.0.0.1:55204/#bootstrap=late-secret');
    assert.equal(waits, 1);
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test('recovers a stopped local Service but refuses a different Service occupying its port', async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'collective-service-manager-recovery-'));
  await writeFile(join(dataDirectory, 'collective-service.json'), '{"serviceInstanceId":"svc_local"}\n');
  await writeFile(
    join(dataDirectory, 'cat-cafe-managed.json'),
    '{"version":1,"serviceUrl":"http://127.0.0.1:55202"}\n',
  );
  let onlineInstance;
  let startCount = 0;
  const manager = new LocalCollectiveServiceManager({
    env: {},
    dataDirectory,
    frontendBaseUrl: 'http://localhost:3003',
    serviceUrl: 'http://127.0.0.1:55202',
    cliPath: '/app/collective-service/cli.js',
    fetchImpl: async (input) => {
      if (!onlineInstance) return offlineFetch();
      if (String(input).endsWith('/api/health')) {
        return Response.json({
          ok: true,
          serviceInstanceId: onlineInstance,
          bootstrapNeeded: false,
          onboardingComplete: true,
        });
      }
      return Response.json({ providers: [{ id: 'github', ready: true, setupSupported: true }] });
    },
    spawnProcess: async () => {
      startCount += 1;
      onlineInstance = 'svc_local';
      return { pid: 41002 };
    },
    wait: async () => undefined,
  });

  assert.equal((await manager.status()).state, 'stopped');
  assert.equal((await manager.recover()).state, 'ready');
  assert.equal(startCount, 1);
  onlineInstance = 'svc_foreign';
  await assert.rejects(() => manager.provision(), /different Collective Service/i);
  assert.equal(startCount, 1);
});

test('never starts a persistent Service from a development or alpha worktree', async () => {
  for (const env of [{ WORKTREE_PORT_OFFSET: '100' }, { CAT_CAFE_SIDECAR_LIFECYCLE_DISABLED: '1' }]) {
    const manager = new LocalCollectiveServiceManager({
      env,
      dataDirectory: await mkdtemp(join(tmpdir(), 'collective-service-manager-guard-')),
      frontendBaseUrl: 'http://localhost:3003',
      serviceUrl: 'http://127.0.0.1:55203',
      cliPath: '/app/collective-service/cli.js',
      fetchImpl: async () => offlineFetch(),
      spawnProcess: async () => {
        throw new Error('must not start');
      },
    });
    await assert.rejects(() => manager.provision(), /runtime environment/i);
  }
});

test('starts the real Service process and recovers the same durable home after process stop', async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'collective-service-manager-live-'));
  const servicePort = await availablePort();
  const serviceUrl = `http://127.0.0.1:${servicePort}`;
  const children = [];
  const manager = new LocalCollectiveServiceManager({
    env: { HOME: dataDirectory, PATH: process.env.PATH },
    dataDirectory,
    frontendBaseUrl: 'http://127.0.0.1:55219',
    serviceUrl,
    cliPath: resolve(REPO_ROOT, 'packages/collective-service/dist/cli.js'),
    spawnProcess: async (spec) => {
      const child = spawn(spec.command, [...spec.args], {
        env: { ...spec.env },
        stdio: 'ignore',
      });
      await new Promise((resolveSpawn, rejectSpawn) => {
        child.once('spawn', resolveSpawn);
        child.once('error', rejectSpawn);
      });
      assert.ok(child.pid);
      children.push(child);
      return { pid: child.pid };
    },
  });

  try {
    const first = await manager.provision();
    assert.equal(first.service.state, 'setup_required');
    assert.equal(first.service.setupStep, 'github_app');
    assert.match(first.launchUrl, new RegExp(`^${serviceUrl.replaceAll('.', '\\.')}/#bootstrap=`));
    const firstInstanceId = first.service.serviceInstanceId;
    assert.ok(firstInstanceId);
    const client = await fetch(serviceUrl);
    assert.equal(client.status, 200);
    assert.equal(client.headers.get('x-collective-client-build'), 'collective-client-v2');

    await stopChild(children[0]);
    assert.equal((await manager.status()).state, 'stopped');
    const recovered = await manager.recover();
    assert.equal(recovered.state, 'setup_required');
    assert.equal(recovered.serviceInstanceId, firstInstanceId);
    assert.equal(children.length, 2);
  } finally {
    await Promise.all(children.map(stopChild));
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

function availablePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once('error', rejectPort);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      server.close((error) => (error ? rejectPort(error) : resolvePort(address.port)));
    });
  });
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolveExit) => child.once('exit', resolveExit)),
    new Promise((resolveTimeout) => setTimeout(resolveTimeout, 5_000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}
