import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  RuntimeDeploymentLedger,
  RuntimeDeploymentLedgerError,
} from '../dist/domains/runtime-deployment/RuntimeDeploymentLedger.js';

const REVISION = 'a'.repeat(40);

test('runtime composition admits the singleton before recording its boot', async () => {
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  const leaseAdmission = source.indexOf('await apiInstanceLease.acquire()');
  const beginBoot = source.indexOf('await ledger.beginBoot(');
  assert.ok(leaseAdmission >= 0 && beginBoot > leaseAdmission);
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'f323-ledger-'));
  const file = join(dir, 'runtime-deployment.json');
  let now = 1_000;
  let id = 0;
  const ledger = new RuntimeDeploymentLedger({
    file,
    installationId: 'abc123def456',
    now: () => now,
    createBootId: () => `boot-${++id}`,
  });
  return {
    file,
    ledger,
    setNow(value) {
      now = value;
    },
  };
}

test('boot sequence is persistent and independent of wall-clock rollback', async () => {
  const h = await fixture();
  const first = await h.ledger.beginBoot({ deploymentId: 'runtime', runningRevision: REVISION });
  h.setNow(500);
  const cold = new RuntimeDeploymentLedger({
    file: h.file,
    installationId: 'abc123def456',
    now: () => 500,
    createBootId: () => 'boot-cold',
  });
  const second = await cold.beginBoot({ deploymentId: 'runtime', runningRevision: REVISION });

  assert.equal(first.bootSequence, 1);
  assert.equal(second.bootSequence, 2);
  assert.equal(second.startedAt, 500);
  const history = await cold.readHistory('runtime');
  assert.equal(history[0].exit, undefined, 'a missing exit stays unknown rather than becoming a crash claim');
});

test('ready and clean exit facts fence the exact boot identity', async () => {
  const h = await fixture();
  const boot = await h.ledger.beginBoot({ deploymentId: 'runtime', runningRevision: REVISION });
  await assert.rejects(
    h.ledger.markReady({ deploymentId: 'runtime', bootId: 'wrong', services: ['api'] }),
    RuntimeDeploymentLedgerError,
  );
  await h.ledger.markReady({ deploymentId: 'runtime', bootId: boot.bootId, services: ['api'] });
  h.setNow(1_200);
  await h.ledger.markReady({ deploymentId: 'runtime', bootId: boot.bootId, services: ['web'] });
  h.setNow(1_500);
  await h.ledger.completeCleanExit({ deploymentId: 'runtime', bootId: boot.bootId, signal: 'SIGTERM' });

  const [stored] = await h.ledger.readHistory('runtime');
  assert.deepEqual(stored.readyServices, ['api', 'web']);
  assert.deepEqual(stored.serviceReadyAt, { api: 1_000, web: 1_200 });
  assert.equal(stored.readyAt, 1_200);
  assert.deepEqual(stored.exit, { kind: 'clean', completedAt: 1_500, signal: 'SIGTERM' });
});

test('startup failure is not a clean exit and a corrupt ledger fails closed', async () => {
  const h = await fixture();
  const boot = await h.ledger.beginBoot({ deploymentId: 'runtime', runningRevision: null });
  await h.ledger.recordStartupFailure({ deploymentId: 'runtime', bootId: boot.bootId, reason: 'recovery_failed' });
  const [stored] = await h.ledger.readHistory('runtime');
  assert.equal(stored.exit.kind, 'startup_failed');
  assert.equal(stored.readyAt, undefined);

  await writeFile(h.file, '{not-json', 'utf8');
  await assert.rejects(h.ledger.readCurrent('runtime'), RuntimeDeploymentLedgerError);
  assert.equal((await readFile(h.file, 'utf8')).startsWith('{not-json'), true, 'corrupt evidence is not overwritten');
});

test('an exited boot rejects markReady and any second exit record', async () => {
  const h = await fixture();
  const boot = await h.ledger.beginBoot({ deploymentId: 'runtime', runningRevision: REVISION });
  await h.ledger.completeCleanExit({ deploymentId: 'runtime', bootId: boot.bootId, signal: 'SIGTERM' });
  await assert.rejects(
    h.ledger.markReady({ deploymentId: 'runtime', bootId: boot.bootId, services: ['api'] }),
    RuntimeDeploymentLedgerError,
  );
  await assert.rejects(
    h.ledger.completeCleanExit({ deploymentId: 'runtime', bootId: boot.bootId, signal: 'SIGTERM' }),
    RuntimeDeploymentLedgerError,
  );
  const [stored] = await h.ledger.readHistory('runtime');
  assert.deepEqual(stored.readyServices, [], 'no readiness is recorded after exit');
  assert.deepEqual(stored.exit, { kind: 'clean', completedAt: 1_000, signal: 'SIGTERM' });
});

test('a ready boot is not a startup failure', async () => {
  const h = await fixture();
  const boot = await h.ledger.beginBoot({ deploymentId: 'runtime', runningRevision: REVISION });
  await h.ledger.markReady({ deploymentId: 'runtime', bootId: boot.bootId, services: ['api', 'web'] });
  await assert.rejects(
    h.ledger.recordStartupFailure({ deploymentId: 'runtime', bootId: boot.bootId, reason: 'recovery_failed' }),
    RuntimeDeploymentLedgerError,
  );
  const [stored] = await h.ledger.readHistory('runtime');
  assert.equal(stored.exit, undefined, 'a ready boot keeps serving instead of being tombstoned');
});

test('beginBoot rejects a malformed running revision without recording a boot', async () => {
  const h = await fixture();
  await assert.rejects(
    h.ledger.beginBoot({ deploymentId: 'runtime', runningRevision: 'main' }),
    RuntimeDeploymentLedgerError,
  );
  await assert.rejects(
    h.ledger.beginBoot({ deploymentId: 'runtime', runningRevision: REVISION.toUpperCase() }),
    RuntimeDeploymentLedgerError,
  );
  assert.equal(await h.ledger.readCurrent('runtime'), null, 'no boot is recorded for invalid input');
});

test('an unreadable ledger file fails closed instead of being overwritten', async () => {
  const h = await fixture();
  await mkdir(h.file);
  await assert.rejects(h.ledger.readCurrent('runtime'), RuntimeDeploymentLedgerError);
  await assert.rejects(
    h.ledger.beginBoot({ deploymentId: 'runtime', runningRevision: REVISION }),
    RuntimeDeploymentLedgerError,
  );
  assert.equal((await stat(h.file)).isDirectory(), true, 'unreadable evidence is not overwritten');
});

test('a ledger written by another installation is rejected and left untouched', async () => {
  const h = await fixture();
  const boot = await h.ledger.beginBoot({ deploymentId: 'runtime', runningRevision: REVISION });
  const foreign = new RuntimeDeploymentLedger({
    file: h.file,
    installationId: 'ffee00dd11',
    createBootId: () => 'boot-foreign',
  });
  await assert.rejects(foreign.readCurrent('runtime'), RuntimeDeploymentLedgerError);
  await assert.rejects(
    foreign.beginBoot({ deploymentId: 'runtime', runningRevision: REVISION }),
    RuntimeDeploymentLedgerError,
  );
  const [stored] = await h.ledger.readHistory('runtime');
  assert.equal(stored.bootId, boot.bootId, 'the original installation data is untouched');
});
