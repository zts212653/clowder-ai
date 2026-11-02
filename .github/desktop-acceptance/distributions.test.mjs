import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { candidateRoot, cleanupConfirmed, verifyDistributions } from './distributions.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'f330-candidate-checks-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const write = async (kind, file, value) => {
    const directory = path.join(root, 'evidence', kind);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, file), JSON.stringify(value));
  };
  return {
    root,
    write,
    clean: (kind, attemptId) =>
      write(kind, 'cleanup-confirmed.json', {
        distribution: kind,
        attemptId,
        ownedProcessesAbsent: true,
        portsFree: true,
      }),
    passed: (kind, attemptId) => write(kind, 'result.json', { distribution: kind, attemptId, status: 'passed' }),
    result: async () => JSON.parse(await fs.readFile(path.join(root, 'evidence', 'distribution-results.json'), 'utf8')),
  };
}

test('native adapter preserves installer failure and still records an independently clean portable result', async (t) => {
  const h = await fixture(t);
  const calls = [];
  await assert.rejects(
    verifyDistributions(h.root, async (kind, attemptId) => {
      calls.push(kind);
      await h.clean(kind, attemptId);
      if (kind === 'installer') throw new Error('native create rejected');
      await h.passed(kind, attemptId);
    }),
  );
  assert.deepEqual(calls, ['installer', 'portable']);
  const result = await h.result();
  assert.equal(result.status, 'failed');
  assert.deepEqual(
    result.checks.map((x) => x.status),
    ['failed', 'passed'],
  );
});

test('missing process/port cleanup proof prevents another native launch', async (t) => {
  const h = await fixture(t);
  const calls = [];
  await assert.rejects(
    verifyDistributions(h.root, async (kind, attemptId) => {
      calls.push(kind);
      await h.passed(kind, attemptId);
    }),
  );
  assert.deepEqual(calls, ['installer']);
  const result = await h.result();
  assert.equal(result.checks[0].cleanup, 'unconfirmed');
  assert.equal(result.checks[1].status, 'not_run');
});

test('a cleanup receipt from an earlier attempt cannot admit the next distribution', async (t) => {
  const h = await fixture(t);
  const calls = [];
  await assert.rejects(
    verifyDistributions(h.root, async (kind) => {
      calls.push(kind);
      await h.clean(kind, 'earlier-attempt');
      throw new Error('current child failed before cleanup');
    }),
  );
  assert.deepEqual(calls, ['installer']);
  assert.equal((await h.result()).checks[1].status, 'not_run');
});

test('exit zero without the actual passed receipt cannot certify either distribution', async (t) => {
  const h = await fixture(t);
  await assert.rejects(
    verifyDistributions(h.root, async (kind, attemptId) => {
      await h.clean(kind, attemptId);
    }),
  );
  assert.deepEqual(
    (await h.result()).checks.map((x) => x.status),
    ['failed', 'failed'],
  );
});

test('two actual passed receipts plus their cleanups are required for success', async (t) => {
  const h = await fixture(t);
  await verifyDistributions(h.root, async (kind, attemptId) => {
    await h.clean(kind, attemptId);
    await h.passed(kind, attemptId);
  });
  assert.equal((await h.result()).status, 'passed');
});

test('cleanup strings, missing facts and another distribution are not proof', () => {
  for (const receipt of [
    undefined,
    {},
    { distribution: 'installer', ownedProcessesAbsent: 'true', portsFree: true },
    { distribution: 'portable', ownedProcessesAbsent: true, portsFree: true },
  ]) {
    assert.equal(cleanupConfirmed(receipt, 'installer'), false);
  }
});

test('candidate output is confined to the download-owned runner directory', () => {
  const runner = path.join(tmpdir(), 'runner-checks');
  assert.equal(
    candidateRoot(path.join(runner, 'f330-candidate-test'), runner),
    path.join(runner, 'f330-candidate-test'),
  );
  for (const root of [runner, path.join(runner, 'unowned'), path.join(runner, '..', 'f330-candidate-other')])
    assert.throws(() => candidateRoot(root, runner));
});
