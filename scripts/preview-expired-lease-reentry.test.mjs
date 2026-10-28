import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { acquireNamedAlphaLifecycle } from './lib/alpha-lifecycle-lock.mjs';
import { stop } from './lib/preview-alpha-settlement-test-fixture.mjs';
import { expiredLeaseFixture, retainedBytes } from './lib/preview-expired-lease-test-fixture.mjs';

for (const boundary of ['afterSettlementJournal', 'afterRetiredLease']) {
  test(`crash at ${boundary} resumes the exact journal without replaying protocol or changing failure evidence`, async (t) => {
    const f = expiredLeaseFixture(t);
    const before = retainedBytes(f);
    f.recovery[boundary] = () => {
      throw new Error('fixture crash');
    };
    await assert.rejects(stop(f), /fixture crash/);
    const resultPath = join(`${f.record.completionPath}.settlement`, 'result.json');
    const published = readFileSync(resultPath);
    assert.equal(existsSync(f.leaseFile), boundary !== 'afterRetiredLease');
    assert.ok(existsSync(f.config.recordPath));
    delete f.recovery[boundary];
    const result = await stop(f);
    assert.equal(result.settlement.leaseStatus, 'retired');
    assert.equal(existsSync(f.config.recordPath), false);
    assert.equal(existsSync(f.leaseFile), false);
    assert.deepEqual(readFileSync(resultPath), published);
    assert.deepEqual(readFileSync(f.record.completionPath), before[1]);
    assert.deepEqual(readFileSync(`${f.record.completionPath}.owner.json`), before[2]);
    assert.deepEqual(readFileSync(f.dumpFile), before[4]);
  });
}

for (const corruption of ['result-missing', 'publication-missing', 'lease-archive', 'data-archive']) {
  test(`missing live lease cannot downgrade a ${corruption} retirement journal to no-lease settlement`, async (t) => {
    const f = expiredLeaseFixture(t);
    f.recovery.afterRetiredLease = () => {
      throw new Error('fixture crash');
    };
    await assert.rejects(stop(f), /fixture crash/);
    delete f.recovery.afterRetiredLease;
    const directory = `${f.record.completionPath}.settlement`;
    if (corruption === 'result-missing') rmSync(join(directory, 'result.json'));
    else if (corruption === 'publication-missing') {
      rmSync(join(directory, 'result.json'));
      rmSync(join(directory, 'intent.json'));
    } else if (corruption === 'lease-archive') writeFileSync(join(directory, 'lease.json'), '{}');
    else {
      const result = JSON.parse(readFileSync(join(directory, 'result.json')));
      writeFileSync(result.data[0].savedPath, 'changed');
    }
    await assert.rejects(stop(f), /disappeared|publication proof|source changed|archived data changed/);
    assert.ok(existsSync(f.config.recordPath));
  });
}

test('both mutation and named lifecycle locks remain held after lease deletion until the record is released', async (t) => {
  const f = expiredLeaseFixture(t);
  f.recovery.afterRetiredLease = async () => {
    assert.ok(existsSync(f.config.recordPath));
    assert.equal(existsSync(f.leaseFile), false);
    await assert.rejects(stop(f), /mutation already active/);
    await assert.rejects(acquireNamedAlphaLifecycle(f.lease.coordinates), /lifecycle is active or unproven/);
  };
  await stop(f);
  const unlock = await acquireNamedAlphaLifecycle(f.lease.coordinates);
  await unlock();
});
