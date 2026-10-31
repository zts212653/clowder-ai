import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('F200 types + shadow flag', () => {
  it('freezeF200Flags defaults to off', async () => {
    delete process.env.F200_CONSUMPTION_RERANK;
    const { freezeF200Flags } = await import('../../dist/domains/memory/f200-types.js');
    const flags = freezeF200Flags();
    assert.equal(flags.consumptionRerank, 'off');
  });

  it('freezeF200Flags reads env var', async () => {
    process.env.F200_CONSUMPTION_RERANK = 'shadow';
    const mod = await import(`../../dist/domains/memory/f200-types.js?t=${Date.now()}`);
    const flags = mod.freezeF200Flags();
    assert.equal(flags.consumptionRerank, 'shadow');
    delete process.env.F200_CONSUMPTION_RERANK;
  });

  it('flags object is frozen', async () => {
    const { freezeF200Flags } = await import(`../../dist/domains/memory/f200-types.js?v=frozen`);
    const flags = freezeF200Flags();
    assert.throws(() => {
      flags.consumptionRerank = 'on';
    }, TypeError);
  });
});
