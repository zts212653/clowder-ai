import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspectRecoveryLoops } from './lib/recovery-loop-contract.mjs';

for (const [name, source] of [
  ['direct interval', 'function boot() { const timer = setInterval(() => recover(), 30); }'],
  [
    'wrapper alias',
    'export function start(options) { const clock = options.timer ?? setInterval; return clock(() => options.reaper.run(), 30); }',
  ],
  ['recursive timeout', 'function tick() { recover().finally(() => setTimeout(tick, 30)); } tick();'],
  ['interval TaskSpec', "export function spec() { return { id: 'probe', trigger: { type: 'interval', ms: 30 } }; }"],
  [
    'cron TaskSpec',
    "export function spec() { return { id: 'poll', trigger: { type: 'cron', expression: '* * * * *' } }; }",
  ],
]) {
  test(`rejects an unregistered ${name}`, () => {
    const result = inspectRecoveryLoops(new Map([['packages/api/src/new-loop.ts', source]]), []);
    assert.equal(result.sites.length, 1, 'the actual scheduling site must be discovered');
    assert.deepEqual(
      result.findings.map((finding) => finding.code),
      ['unregistered'],
    );
  });
}

test('a one-shot timeout is not a periodic recovery loop', () => {
  const result = inspectRecoveryLoops(
    new Map([['one-shot.ts', 'function expire() { setTimeout(() => cancel(), 30); }']]),
    [],
  );
  assert.deepEqual(result.sites, []);
  assert.deepEqual(result.findings, []);
});

test('discovers both branches of a declared plugin schedule', () => {
  const result = inspectRecoveryLoops(
    new Map([
      [
        'plugin.ts',
        "function schedule(c) { return { trigger: c.interval ? { type: 'interval', ms: 1 } : { type: 'cron', expression: '* * * * *' } }; }",
      ],
    ]),
    [],
  );
  assert.equal(result.sites.length, 2);
});

test('timer aliases are lexical: a sibling timeout cannot hide an interval wrapper', () => {
  const result = inspectRecoveryLoops(
    new Map([
      [
        'wrappers.ts',
        `
    function start(options) { const clock = options.timer ?? setInterval; return clock(() => recover(), 30); }
    function deadline(options) { const clock = options.timer ?? setTimeout; return clock(() => expire(), 30); }
  `,
      ],
    ]),
    [],
  );
  assert.equal(result.sites.length, 1);
  assert.match(result.sites[0].key, /#start/);
});

test('discovers a periodic Node timer imported under another name', () => {
  const result = inspectRecoveryLoops(
    new Map([
      [
        'alias.ts',
        "import { setInterval as repeat } from 'node:timers'; function boot() { const timer = repeat(recover, 30); }",
      ],
    ]),
    [],
  );
  assert.equal(result.sites.length, 1);
});

test('registration records the pending migration without pretending access is indexed', () => {
  const sources = new Map([['loop.ts', 'function boot() { const timer = setInterval(recover, 30); }']]);
  const registration = {
    id: 'wake',
    sites: ['loop.ts#boot.timer'],
    owner: 'ball-custody',
    state: 'pending',
    reason: 'B2 migrates the existing owner reads',
  };
  const result = inspectRecoveryLoops(sources, [registration]);
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.pending, ['wake']);
});

test('an exemption needs a reason and cannot silently swallow a second site', () => {
  const sources = new Map([
    ['loop.ts', 'function boot() { const first = setInterval(recover, 30); const second = setInterval(other, 30); }'],
  ]);
  const result = inspectRecoveryLoops(sources, [
    { id: 'heartbeat', sites: ['loop.ts#boot.first'], state: 'exempt', reason: '' },
  ]);
  assert.deepEqual(result.findings.map((finding) => finding.code).sort(), ['missing-reason', 'unregistered']);
});

test('stale and duplicate registrations fail instead of hiding a moved loop', () => {
  const registration = { id: 'clock', sites: ['gone.ts#boot.timer'], state: 'exempt', reason: 'ephemeral heartbeat' };
  const result = inspectRecoveryLoops(new Map(), [registration, { ...registration, id: 'duplicate' }]);
  assert.ok(result.findings.some((finding) => finding.code === 'stale-registration'));
  assert.ok(result.findings.some((finding) => finding.code === 'duplicate-site'));
});

test('logical recovery registrations cannot hide behind one shared cadence factory', () => {
  const result = inspectRecoveryLoops(
    new Map([
      [
        'boot.ts',
        `function boot() {
    runner.registerRecoveryLoop({ id: 'first-owner', intervalMs: 30, runOnce: work });
    runner.registerRecoveryLoop({ id: 'second-owner', intervalMs: 30, runOnce: work });
  }`,
      ],
    ]),
    [],
  );
  assert.equal(result.sites.length, 2);
  assert.deepEqual(
    result.sites.map((site) => site.key),
    ['boot.ts#boot.recovery:first-owner', 'boot.ts#boot.recovery:second-owner'],
  );
  assert.equal(result.findings.length, 2);
});
