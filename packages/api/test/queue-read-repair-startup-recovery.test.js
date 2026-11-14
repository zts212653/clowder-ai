import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readRepairFixture } from './helpers/read-repair-fixture.js';

// F048 Phase C, 11-10 boot 84: the Hub reconnected within a second of listen. This read repair
// ended three restart-interrupted executions as `execution_owner_lost` 16 seconds before startup
// recovery reached them, so recovery saw nothing to end as `process_restart` and woke no cat.
describe('active execution read repair waits for startup recovery', () => {
  it('lists a prior-process execution without ending it until startup recovery finishes', async (t) => {
    let recovered = false;
    const h = await readRepairFixture(t, undefined, { isStartupRecoveryComplete: () => recovered });

    for (const scope of ['thread', 'project', 'all']) await h.poll(scope);
    assert.equal(h.transition.mock.callCount(), 0, 'no terminal write while startup recovery owns the record');
    assert.equal(h.parent.status, 'running');
    assert.equal((await h.turnExecutionStore.get(h.childId)).status, 'running');

    recovered = true;
    await h.poll('all');
    assert.ok(h.transition.mock.callCount() > 0, 'after recovery the ordinary repair runs again');
    assert.equal(h.parent.status, 'failed');
  });

  it('keeps repairing as before when no startup recovery signal is wired', async (t) => {
    const h = await readRepairFixture(t);
    await h.poll('all');
    assert.ok(h.transition.mock.callCount() > 0);
    assert.equal(h.parent.status, 'failed');
  });
});
