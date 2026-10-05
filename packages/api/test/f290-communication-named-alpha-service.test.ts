import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, symlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { deriveNamedAlphaCoordinates, namedAlphaEnvironment } from '../../../scripts/lib/alpha-coordinates.mjs';
import { NAMED_ALPHA_PORTS, namedAlphaFixture } from '../../../scripts/lib/alpha-named-fixture.mjs';
import { resolveNamedAlphaRuntimeBoundary } from '../src/config/alpha-coordinates.js';
import { LocalCollectiveServiceManager } from '../src/domains/plugin/builtin-runtime/local-collective-service-manager.js';
import type { LocalCollectiveServiceSpawnSpec } from '../src/domains/plugin/builtin-runtime/local-collective-service-process.js';

async function boundaryFixture(t: Parameters<typeof namedAlphaFixture>[0]) {
  const f = namedAlphaFixture(t);
  f.preparedBuilds();
  const coordinates = deriveNamedAlphaCoordinates({
    mainRoot: f.mainRoot,
    instance: 'f290-communication',
    ports: NAMED_ALPHA_PORTS,
    targetSha: f.head,
  });
  const env = namedAlphaEnvironment(coordinates);
  const loader: { resolveNamedAlphaRuntimeBoundary: typeof resolveNamedAlphaRuntimeBoundary } = await import(
    pathToFileURL(join(f.alphaRoot, 'packages/api/src/config/alpha-coordinates.ts')).href
  );
  const boundary = await loader.resolveNamedAlphaRuntimeBoundary(env);
  assert.ok(boundary);
  return {
    f,
    env,
    boundary,
    options: {
      env,
      alphaRoot: f.alphaRoot,
      namedAlphaBoundary: boundary,
      frontendBaseUrl: 'http://localhost:5311',
      serviceUrl: 'http://127.0.0.1:5511',
      dataDirectory: join(f.alphaRoot, '.cat-cafe/collective-service'),
      cliPath: join(f.alphaRoot, 'packages/collective-service/dist/cli.js'),
    },
  };
}

test('the actual installed Alpha coordinate loader refuses an arbitrary environment binary root', async (t) => {
  const f = namedAlphaFixture(t);
  f.preparedBuilds();
  const coordinates = deriveNamedAlphaCoordinates({
    mainRoot: f.mainRoot,
    instance: 'f290-communication',
    ports: NAMED_ALPHA_PORTS,
    targetSha: f.head,
  });
  await assert.rejects(
    resolveNamedAlphaRuntimeBoundary(namedAlphaEnvironment(coordinates)),
    /installation root changed/,
  );
});

test('the real Manager consumes the canonical named Alpha tuple, isolated Service home and origins', async (t) => {
  const f = namedAlphaFixture(t);
  f.preparedBuilds();
  const coordinates = deriveNamedAlphaCoordinates({
    mainRoot: f.mainRoot,
    instance: 'f290-communication',
    ports: NAMED_ALPHA_PORTS,
    targetSha: f.head,
  });
  const env = namedAlphaEnvironment(coordinates);
  const loader = await import(pathToFileURL(join(f.alphaRoot, 'packages/api/src/config/alpha-coordinates.ts')).href);
  const boundary = await loader.resolveNamedAlphaRuntimeBoundary(env);
  assert.equal(boundary.isCurrent(), true);
  const dataDirectory = join(f.alphaRoot, '.cat-cafe/collective-service');
  const starts: Array<{ env: Readonly<Record<string, string>>; detached: boolean }> = [];
  let online = false;
  const manager = new LocalCollectiveServiceManager({
    env,
    alphaRoot: f.alphaRoot,
    namedAlphaBoundary: boundary,
    frontendBaseUrl: 'http://localhost:5311',
    serviceUrl: 'http://127.0.0.1:5511',
    dataDirectory,
    cliPath: join(f.alphaRoot, 'packages/collective-service/dist/cli.js'),
    fetchImpl: async (input) => {
      if (!online) throw new Error('offline fixture transport');
      return String(input).endsWith('/api/health')
        ? Response.json({
            ok: true,
            serviceInstanceId: 'named-alpha-instance',
            bootstrapNeeded: true,
            onboardingComplete: false,
          })
        : Response.json({ providers: [{ id: 'github', ready: false, setupSupported: true }] });
    },
    spawnProcess: async (spec) => {
      starts.push(spec);
      await mkdir(dataDirectory, { recursive: true });
      await writeFile(join(dataDirectory, 'collective-service.json'), '{"serviceInstanceId":"named-alpha-instance"}\n');
      await writeFile(join(dataDirectory, 'owner-bootstrap.url'), 'http://127.0.0.1:5511/#bootstrap=isolated-secret\n');
      online = true;
      return { pid: 41025 };
    },
    wait: async () => undefined,
  });
  assert.equal((await manager.status()).state, 'not_created');
  const launch = await manager.provision();
  assert.equal(launch.service.serviceInstanceId, 'named-alpha-instance');
  assert.equal(starts[0]?.env.COLLECTIVE_SERVICE_PORT, '5511');
  assert.equal(starts[0]?.env.COLLECTIVE_SERVICE_DATA_DIR, dataDirectory);
  assert.equal(starts[0]?.env.COLLECTIVE_SERVICE_ALLOWED_HOST_ORIGINS, 'http://localhost:5311,http://127.0.0.1:5311');
  assert.equal(starts[0]?.detached, false);
  env.FRONTEND_PORT = '3011';
  assert.equal(boundary.isCurrent(), false);
  assert.equal((await manager.status()).state, 'error');
  await assert.rejects(manager.provision());
  assert.equal(starts.length, 1);
});

test('named Alpha does not gain lifecycle authority from its label, caller URL or missing validator', async (t) => {
  const { options, env, f } = await boundaryFixture(t);
  let effects = 0;
  for (const override of [
    { namedAlphaBoundary: undefined },
    { serviceUrl: 'http://127.0.0.1:5211' },
    { dataDirectory: join(f.mainRoot, '.cat-cafe/collective-service') },
    { frontendBaseUrl: 'http://localhost:3011' },
    { cliPath: join(f.mainRoot, 'packages/collective-service/dist/cli.js') },
  ]) {
    const manager = new LocalCollectiveServiceManager({
      ...options,
      ...override,
      fetchImpl: async () => {
        effects += 1;
        throw new Error('must not read');
      },
      spawnProcess: async () => {
        effects += 1;
        return { pid: 42 };
      },
    });
    assert.equal((await manager.status()).state, 'error');
    assert.equal((await manager.recover()).state, 'error');
    await assert.rejects(manager.provision());
  }
  env.CAT_CAFE_DEPLOYMENT_ID = 'runtime';
  const relabeled = new LocalCollectiveServiceManager({
    ...options,
    fetchImpl: async () => {
      effects += 1;
      throw new Error('must not read');
    },
    spawnProcess: async () => {
      effects += 1;
      return { pid: 42 };
    },
  });
  assert.equal((await relabeled.status()).state, 'error');
  await assert.rejects(relabeled.provision());
  assert.equal(effects, 0);
});

test('current coordinates are reverified after an awaited inspection before spawning a Service', async (t) => {
  const { options, env } = await boundaryFixture(t);
  let spawned = false;
  const manager = new LocalCollectiveServiceManager({
    ...options,
    fetchImpl: async () => {
      env.FRONTEND_PORT = '3001';
      throw new Error('offline fixture with concurrent tamper');
    },
    spawnProcess: async () => {
      spawned = true;
      return { pid: 42 };
    },
  });
  await assert.rejects(manager.provision());
  assert.equal(spawned, false);
});

test('a named Service foreign instance cannot be recovered through the local ownership marker', async (t) => {
  const { options } = await boundaryFixture(t);
  await mkdir(options.dataDirectory, { recursive: true });
  await writeFile(
    join(options.dataDirectory, 'collective-service.json'),
    '{"serviceInstanceId":"actual-local-instance"}\n',
  );
  let spawned = false;
  const manager = new LocalCollectiveServiceManager({
    ...options,
    fetchImpl: async (input) =>
      String(input).endsWith('/api/health')
        ? Response.json({
            ok: true,
            serviceInstanceId: 'foreign-instance',
            bootstrapNeeded: false,
            onboardingComplete: true,
          })
        : Response.json({ providers: [{ id: 'github', ready: true, setupSupported: true }] }),
    spawnProcess: async () => {
      spawned = true;
      return { pid: 42 };
    },
  });
  assert.equal((await manager.status()).state, 'error');
  await assert.rejects(manager.provision(), /different Collective Service/);
  assert.equal(spawned, false);
});

test('actual compiled Service starts at the named coordinate and recovers its same isolated durable instance', async (t) => {
  const f = namedAlphaFixture(t);
  const listener = net.createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const address = listener.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  await new Promise<void>((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
  const tuple = `5311,5312,5411,${port},15397`;
  const coordinates = deriveNamedAlphaCoordinates({
    mainRoot: f.mainRoot,
    instance: 'f290-communication',
    ports: tuple,
    targetSha: f.head,
  });
  f.preparedBuilds();
  // Real compiled production consumer in an explicit temporary Git/build metadata fixture;
  // this does not claim the eventual legal main deployment has been loaded.
  const repoRoot = new URL('../../../', import.meta.url);
  await cp(
    new URL('packages/collective-service/dist/', repoRoot),
    join(f.alphaRoot, 'packages/collective-service/dist'),
    { recursive: true },
  );
  await symlink(new URL('node_modules/', repoRoot).pathname, join(f.alphaRoot, 'node_modules'), 'dir');
  const env = { ...namedAlphaEnvironment(coordinates), HOME: f.env.HOME, PATH: process.env.PATH };
  const loader: { resolveNamedAlphaRuntimeBoundary: typeof resolveNamedAlphaRuntimeBoundary } = await import(
    pathToFileURL(join(f.alphaRoot, 'packages/api/src/config/alpha-coordinates.ts')).href
  );
  const boundary = await loader.resolveNamedAlphaRuntimeBoundary(env);
  assert.ok(boundary);
  const children: Array<ReturnType<typeof spawn>> = [];
  const starts: LocalCollectiveServiceSpawnSpec[] = [];
  const manager = new LocalCollectiveServiceManager({
    env,
    alphaRoot: f.alphaRoot,
    namedAlphaBoundary: boundary,
    frontendBaseUrl: 'http://localhost:5311',
    serviceUrl: `http://127.0.0.1:${port}`,
    dataDirectory: join(f.alphaRoot, '.cat-cafe/collective-service'),
    cliPath: join(f.alphaRoot, 'packages/collective-service/dist/cli.js'),
    spawnProcess: async (spec) => {
      starts.push(spec);
      const child = spawn(spec.command, [...spec.args], { env: { ...spec.env }, cwd: f.alphaRoot, stdio: 'ignore' });
      children.push(child);
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      assert.ok(child.pid);
      return { pid: child.pid };
    },
  });
  async function stop(child: ReturnType<typeof spawn>) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill('SIGTERM');
    await exited;
  }
  try {
    const first = await manager.provision();
    assert.equal(first.service.state, 'setup_required');
    assert.ok(first.service.serviceInstanceId);
    assert.equal(starts[0]?.env.COLLECTIVE_SERVICE_ALLOWED_HOST_ORIGINS, 'http://localhost:5311,http://127.0.0.1:5311');
    assert.equal(starts[0]?.detached, false);
    const firstChild = children[0];
    assert.ok(firstChild);
    await stop(firstChild);
    assert.equal((await manager.status()).state, 'stopped');
    const recovered = await manager.recover();
    assert.equal(recovered.serviceInstanceId, first.service.serviceInstanceId);
    assert.equal(starts.length, 2);
  } finally {
    await Promise.all(children.map(stop));
  }
});
