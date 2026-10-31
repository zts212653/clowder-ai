import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('Task Profiles', () => {
  it('awareness profile has 30-min interval and drop whenNoSignal', async () => {
    const { PROFILE_DEFAULTS } = await import('../../dist/infrastructure/scheduler/profiles.js');
    const p = PROFILE_DEFAULTS.awareness;
    assert.equal(p.trigger.ms, 30 * 60 * 1000);
    assert.equal(p.run.timeoutMs, 120_000);
    assert.equal(p.outcome.whenNoSignal, 'drop');
  });

  it('poller profile has 60s interval and record whenNoSignal', async () => {
    const { PROFILE_DEFAULTS } = await import('../../dist/infrastructure/scheduler/profiles.js');
    const p = PROFILE_DEFAULTS.poller;
    assert.equal(p.trigger.ms, 60_000);
    assert.equal(p.run.timeoutMs, 30_000);
    assert.equal(p.outcome.whenNoSignal, 'record');
  });
});
