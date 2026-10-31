import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import { RuntimeDeploymentLedger } from '../dist/domains/runtime-deployment/RuntimeDeploymentLedger.js';
import { RuntimeDeploymentObservationProvider } from '../dist/domains/runtime-deployment/RuntimeDeploymentObservationProvider.js';

const INSTALLATION_ID = 'abc123def456';
const roots = [];

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'f323-observe-repo-'));
  roots.push(root);
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'F323 Test');
  git(root, 'config', 'user.email', 'f323@example.test');
  git(root, 'commit', '-q', '--allow-empty', '-m', 'first');
  const first = git(root, 'rev-parse', 'HEAD');
  git(root, 'commit', '-q', '--allow-empty', '-m', 'second');
  const second = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', '-q', first);
  git(root, 'commit', '-q', '--allow-empty', '-m', 'sibling');
  const sibling = git(root, 'rev-parse', 'HEAD');
  return { root, first, second, sibling };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture(runtimeRoot) {
  const dir = await mkdtemp(join(tmpdir(), 'f323-observe-'));
  roots.push(dir);
  const file = join(dir, 'runtime-deployment.json');
  let now = 1_000;
  let id = 0;
  let liveServices = [];
  let readinessCalls = 0;
  const ledger = new RuntimeDeploymentLedger({
    file,
    installationId: INSTALLATION_ID,
    now: () => now,
    createBootId: () => `boot-${++id}`,
  });
  return {
    ledger,
    providerFor(bootId) {
      return new RuntimeDeploymentObservationProvider({
        ledger,
        runtimeRoot,
        installationId: INSTALLATION_ID,
        deploymentId: 'runtime',
        bootId,
        currentReadyServices: async () => {
          readinessCalls++;
          return liveServices;
        },
      });
    },
    readinessCalls() {
      return readinessCalls;
    },
    setNow(value) {
      now = value;
    },
    setLive(services) {
      liveServices = services;
    },
  };
}

test('a boot with a recorded exit cannot wake a wait for the old build', async () => {
  const { root, first } = repo();
  const h = await fixture(root);
  const boot = await h.ledger.beginBoot({ deploymentId: 'runtime', runningRevision: first });
  const provider = h.providerFor(boot.bootId);
  await h.ledger.markReady({ deploymentId: 'runtime', bootId: boot.bootId, services: ['api', 'web'] });
  await h.ledger.completeCleanExit({ deploymentId: 'runtime', bootId: boot.bootId, signal: 'SIGTERM' });
  assert.equal(await provider.observe({ deploymentId: 'runtime', targetRevision: first }), null);
});

test('a different deploymentId is never observed', async () => {
  const { root, first } = repo();
  const h = await fixture(root);
  const boot = await h.ledger.beginBoot({ deploymentId: 'runtime', runningRevision: first });
  const provider = h.providerFor(boot.bootId);
  await h.ledger.markReady({ deploymentId: 'runtime', bootId: boot.bootId, services: ['api', 'web'] });
  assert.equal(await provider.observe({ deploymentId: 'other', targetRevision: first }), null);
});

test('readiness requires current service facts and preserves the exact ledger boot', async () => {
  const { root, first, second, sibling } = repo();
  const h = await fixture(root);
  const boot = await h.ledger.beginBoot({ deploymentId: 'runtime', runningRevision: second });
  const provider = h.providerFor(boot.bootId);

  const starting = await provider.observe({ deploymentId: 'runtime', targetRevision: first });
  assert.ok(starting);
  assert.equal(starting.subjectRef, `deployment:${INSTALLATION_ID}:runtime`);
  assert.equal(starting.bootId, boot.bootId);
  assert.equal(starting.bootSequence, 1);
  assert.equal(starting.runningRevision, second);
  assert.deepEqual(starting.readyServices, [], 'a running build without ledger readiness is not ready');
  assert.deepEqual(starting.inclusionProof, {
    kind: 'git_ancestry',
    targetRevision: first,
    runningRevision: second,
    included: true,
  });
  assert.equal(typeof starting.observedAt, 'number');

  const diverged = await provider.observe({ deploymentId: 'runtime', targetRevision: sibling });
  assert.ok(diverged);
  assert.equal(diverged.inclusionProof.included, false);

  await h.ledger.markReady({ deploymentId: 'runtime', bootId: boot.bootId, services: ['api'] });
  h.setLive(['api']);
  const partial = await provider.observe({ deploymentId: 'runtime' });
  assert.ok(partial);
  assert.deepEqual(partial.readyServices, ['api']);
});

test('a provider never borrows a foreign replacement boot after a SIGKILL', async () => {
  const { root, first, second } = repo();
  const h = await fixture(root);
  const killed = await h.ledger.beginBoot({ deploymentId: 'runtime', runningRevision: first });
  const killedProvider = h.providerFor(killed.bootId);
  await h.ledger.markReady({ deploymentId: 'runtime', bootId: killed.bootId, services: ['api', 'web'] });
  h.setNow(2_000);
  const replacement = await h.ledger.beginBoot({ deploymentId: 'runtime', runningRevision: second });
  await h.ledger.markReady({ deploymentId: 'runtime', bootId: replacement.bootId, services: ['api', 'web'] });
  h.setLive(['api', 'web']);

  assert.equal(await killedProvider.observe({ deploymentId: 'runtime', targetRevision: first }), null);
  assert.equal(h.readinessCalls(), 0, 'foreign boot identity fails closed before probing this process');

  const observation = await h
    .providerFor(replacement.bootId)
    .observe({ deploymentId: 'runtime', targetRevision: first });
  assert.ok(observation);
  assert.equal(observation.bootId, replacement.bootId);
  assert.equal(observation.bootSequence, killed.bootSequence + 1);
  assert.notEqual(observation.bootId, killed.bootId);
  assert.equal(observation.runningRevision, second);
  assert.deepEqual(observation.readyServices, ['api', 'web']);
  assert.equal(observation.inclusionProof.included, true);
});

test('a foreign exited head does not fall back to an older live boot or probe this process', async () => {
  const { root, first, second } = repo();
  const h = await fixture(root);
  const ownBoot = await h.ledger.beginBoot({ deploymentId: 'runtime', runningRevision: first });
  const ownProvider = h.providerFor(ownBoot.bootId);
  await h.ledger.markReady({ deploymentId: 'runtime', bootId: ownBoot.bootId, services: ['api', 'web'] });
  const foreign = await h.ledger.beginBoot({ deploymentId: 'runtime', runningRevision: second });
  await h.ledger.completeCleanExit({ deploymentId: 'runtime', bootId: foreign.bootId, signal: 'SIGTERM' });
  h.setLive(['api', 'web']);

  assert.equal(await ownProvider.observe({ deploymentId: 'runtime', targetRevision: first }), null);
  assert.equal(h.readinessCalls(), 0, 'foreign exit fails closed before probing this process');
  assert.equal((await h.ledger.readCurrent('runtime')).bootId, foreign.bootId, 'history order stays untouched');
});

test('each clean-exit restart is observed under its own boot identity', async () => {
  const { root, first, second } = repo();
  const h = await fixture(root);
  const one = await h.ledger.beginBoot({ deploymentId: 'runtime', runningRevision: first });
  const firstProvider = h.providerFor(one.bootId);
  await h.ledger.markReady({ deploymentId: 'runtime', bootId: one.bootId, services: ['api', 'web'] });
  await h.ledger.completeCleanExit({ deploymentId: 'runtime', bootId: one.bootId, signal: 'SIGTERM' });
  assert.equal(
    await firstProvider.observe({ deploymentId: 'runtime' }),
    null,
    'between shutdown and the next boot there is nothing to observe',
  );

  h.setNow(2_000);
  const two = await h.ledger.beginBoot({ deploymentId: 'runtime', runningRevision: second });
  await h.ledger.markReady({ deploymentId: 'runtime', bootId: two.bootId, services: ['api'] });
  h.setLive(['api']);
  const observation = await h.providerFor(two.bootId).observe({ deploymentId: 'runtime' });
  assert.ok(observation);
  assert.equal(observation.bootId, two.bootId);
  assert.notEqual(observation.bootId, one.bootId);
  assert.equal(observation.bootSequence, one.bootSequence + 1);
  assert.deepEqual(observation.readyServices, ['api']);
});

test('historical Web readiness stops matching when current Web is down, then recovers in the same boot', async () => {
  const { root, first } = repo();
  const h = await fixture(root);
  const boot = await h.ledger.beginBoot({ deploymentId: 'runtime', runningRevision: first });
  const provider = h.providerFor(boot.bootId);
  await h.ledger.markReady({ deploymentId: 'runtime', bootId: boot.bootId, services: ['api', 'web'] });
  h.setLive(['api']);
  assert.deepEqual((await provider.observe({ deploymentId: 'runtime' })).readyServices, ['api']);
  h.setLive(['api', 'web']);
  assert.deepEqual((await provider.observe({ deploymentId: 'runtime' })).readyServices, ['api', 'web']);
});

test('a first readiness check can recover without another boot', async () => {
  const { root, first } = repo();
  const h = await fixture(root);
  const boot = await h.ledger.beginBoot({ deploymentId: 'runtime', runningRevision: first });
  const provider = h.providerFor(boot.bootId);
  assert.deepEqual((await provider.observe({ deploymentId: 'runtime' })).readyServices, []);
  h.setLive(['api', 'web']);
  const recovered = await provider.observe({ deploymentId: 'runtime' });
  assert.equal(recovered.bootId, boot.bootId);
  assert.deepEqual(recovered.readyServices, ['api', 'web']);
  assert.deepEqual((await h.ledger.readCurrent('runtime')).readyServices, ['api', 'web']);
});
