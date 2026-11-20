import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyWatcherConfigPatch, catRegistry, parseWatcherConfig, WATCHER_PANEL_DEFAULTS } from '@cat-cafe/shared';
import {
  InMemoryWatcherPanelLedger,
  watcherPanelRoundId,
} from '../dist/domains/concierge/watcher/panel/watcher-panel-ledger.js';
import { WatcherPanelRunner } from '../dist/domains/concierge/watcher/panel/watcher-panel-runner.js';
import { watcherRoundMembers } from '../dist/domains/concierge/watcher/watcher-routing.js';
import { watcherWorld } from './helpers/watcher-world.js';

test('reading an old enabled pre-scope preference never broadens it to all threads', () => {
  const legacy = parseWatcherConfig({ enabled: true, memberCatId: 'codex', revision: 5 });
  assert.equal(legacy.scope, 'selected');
  assert.equal(legacy.revision, 5);
});

test('production family resolution uses roster and catalog breed metadata for arbitrary members', (t) => {
  const original = catRegistry.getAllConfigs();
  t.after(() => {
    catRegistry.reset();
    for (const [id, config] of Object.entries(original)) catRegistry.register(id, config);
  });
  for (const id of ['custom-cheap-main', 'custom-cheap-worker'])
    catRegistry.register(id, { ...catRegistry.getOrThrow('codex').config, id, breedId: 'custom-cheap-family' });
  const config = applyWatcherConfigPatch(parseWatcherConfig(undefined), {
    routing: {
      primary: { catId: 'custom-cheap-main' },
      whenSameFamily: { mode: 'member', member: { catId: 'opus' } },
      maxConcurrentRuns: 6,
    },
  });
  assert.deepEqual(watcherRoundMembers(config, 'custom-cheap-worker').members, [{ catId: 'opus' }]);
  assert.deepEqual(watcherRoundMembers(config, 'sonnet').members, [{ catId: 'custom-cheap-main' }]);
  assert.deepEqual(watcherRoundMembers(config, 'custom-cheap-main').members, [{ catId: 'opus' }]);
});

test('a new installation is off, needs no thread list, and chooses no fixed member or comparison trio', () => {
  const config = parseWatcherConfig(undefined);
  assert.equal(config.enabled, false);
  assert.equal(config.scope, 'all');
  assert.equal(config.memberCatId, '');
  assert.deepEqual(WATCHER_PANEL_DEFAULTS.members, []);
});

for (const whenSameFamily of [
  { mode: 'primary' },
  { mode: 'skip' },
  { mode: 'member', member: { catId: 'custom-secondary', accountRef: 'secondary-account' } },
]) {
  test(`global settings persist an arbitrary primary and same-family ${whenSameFamily.mode} choice`, () => {
    const routing = {
      primary: { catId: 'custom-primary', accountRef: 'primary-account' },
      whenSameFamily,
      maxConcurrentRuns: 4,
    };
    const next = applyWatcherConfigPatch(parseWatcherConfig(undefined), { routing });
    assert.deepEqual(next.routing, routing);
    assert.deepEqual(parseWatcherConfig(JSON.parse(JSON.stringify(next))).routing, routing);
    assert.equal(next.memberCatId, 'custom-primary', 'legacy display follows the canonical primary');
    assert.equal(next.scope, 'all');
    assert.equal(next.enabled, false, 'choosing a member never turns on the watcher');
  });
}

async function routingWorld(whenSameFamily, families = { codex: 'worker-family', 'custom-primary': 'watcher-family' }) {
  const w = await watcherWorld();
  const routing = { primary: { catId: 'custom-primary' }, whenSameFamily, maxConcurrentRuns: 2 };
  const config = {
    ...parseWatcherConfig(undefined),
    enabled: true,
    scope: 'all',
    routing,
    // An old experiment must not choose the observer of a new routed opportunity.
    panel: { enabled: true, members: [{ catId: 'old-first' }, { catId: 'old-second' }], maxConcurrentRuns: 6 },
  };
  const ledger = new InMemoryWatcherPanelLedger();
  const calls = [],
    guidanceReads = [],
    reports = [];
  const runner = new WatcherPanelRunner({
    ...w,
    userId: 'watcher-owner',
    configs: { readWatcherConfig: async () => config },
    labels: { list: async () => [] },
    ledger,
    queue: {
      enqueueExistingMessageDurable: async () => {
        throw new Error('quiet fixture must not wake');
      },
    },
    transcript: { appendDurableEvent: async () => {} },
    apiUrl: 'http://127.0.0.1:3102',
    service: () => undefined,
    publish() {},
    report: (error) => reports.push(error),
    family: (catId) => families[catId],
    loadGuidance: () => {
      guidanceReads.push(true);
      return { text: '安装方说明', digest: 'sha256:test' };
    },
    runMember: async (_owners, input) => {
      calls.push(input);
      return { status: 'quiet', executionStatus: 'succeeded', sessionId: `session-${input.catId}` };
    },
  });
  return { ...w, config, ledger, calls, guidanceReads, reports, runner };
}

test('a different-family turn runs only the configured primary through the ordinary-context runner', async () => {
  const f = await routingWorld({ mode: 'member', member: { catId: 'custom-secondary' } });
  const [source] = await f.work('不同家的一轮');
  f.runner.offer(source, 0);
  await f.runner.idle();
  assert.deepEqual(
    f.calls.map((call) => call.catId),
    ['custom-primary'],
  );
  assert.deepEqual(f.reports, []);
});

test('the same thread selects an alternate from each settled worker, rather than from a thread assignment', async () => {
  const f = await routingWorld(
    { mode: 'member', member: { catId: 'custom-secondary', accountRef: 'alternate-account' } },
    { codex: 'one-family', 'custom-primary': 'one-family' },
  );
  const [source] = await f.work('同家的一轮');
  f.runner.offer(source, 0);
  await f.runner.idle();
  assert.deepEqual(
    f.calls.map((call) => [call.catId, call.accountRef]),
    [['custom-secondary', 'alternate-account']],
  );
  f.config.routing.whenSameFamily = { mode: 'primary' };
  const [next] = await f.work('明确选择仍由主守望看');
  f.runner.offer(next, 0);
  await f.runner.idle();
  assert.deepEqual(
    f.calls.map((call) => call.catId),
    ['custom-secondary', 'custom-primary'],
  );
});

test('unknown families are not mistaken for the same family', async () => {
  const f = await routingWorld({ mode: 'skip' }, {});
  const [source] = await f.work('家族元数据缺失');
  f.runner.offer(source, 0);
  await f.runner.idle();
  assert.deepEqual(
    f.calls.map((call) => call.catId),
    ['custom-primary'],
  );
});

test('same-family skip records the reason without loading guidance or starting a member', async () => {
  const f = await routingWorld({ mode: 'skip' }, { codex: 'one-family', 'custom-primary': 'one-family' });
  const [source] = await f.work('同家不看');
  f.runner.offer(source, 0);
  await f.runner.idle();
  assert.equal(f.calls.length, 0);
  assert.equal(f.guidanceReads.length, 0);
  const round = await f.ledger.get(watcherPanelRoundId(source.invocationId));
  assert.equal(round.quiet, 'same_family');
  assert.deepEqual(round.members, []);
});

test('a watcher-woken turn records a skip without running even one member', async () => {
  const f = await routingWorld({ mode: 'primary' });
  const trigger = await f.messages.append({
    userId: 'watcher-owner',
    threadId: f.thread.id,
    from: { kind: 'system', service: 'watcher-panel' },
    source: { connector: 'watcher-panel' },
    content: '守望提醒',
    timestamp: Date.now(),
    mentions: [],
  });
  const [source] = await f.work('回应提醒');
  f.runner.offer({ ...source, causal: { ...source.causal, triggerMessageId: trigger.id } }, 0);
  await f.runner.idle();
  assert.equal(f.calls.length, 0);
  assert.equal(f.guidanceReads.length, 0);
  const round = await f.ledger.get(watcherPanelRoundId(source.invocationId));
  assert.equal(round.quiet, 'woken_by_watcher');
  assert.deepEqual(round.members, []);
});
