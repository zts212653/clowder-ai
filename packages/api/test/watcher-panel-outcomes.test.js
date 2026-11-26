import assert from 'node:assert/strict';
import { test } from 'node:test';
import { watcherPanelPrevious } from '../dist/domains/concierge/watcher/panel/watcher-panel-facts.js';
import { InMemoryWatcherPanelLedger } from '../dist/domains/concierge/watcher/panel/watcher-panel-ledger.js';
import { reconcileWatcherPanelRound } from '../dist/domains/concierge/watcher/panel/watcher-panel-outcomes.js';

test('read repair preserves the recorded provider failure instead of replacing it with a terminal label', async () => {
  const failure = 'Codex account discovery timed out after retries';
  const round = {
    userId: 'u',
    threadId: 't',
    roundId: 'r',
    members: [{ catId: 'gpt52', label: '甲', status: 'failed', invocationId: 'i', failure }],
  };
  const executions = {
    get: async () => ({
      invocationId: 'i',
      userId: 'u',
      threadId: 't',
      catId: 'gpt52',
      executionKind: 'watcher',
      causal: { watcherPanelRoundId: 'r' },
      status: 'failed',
      terminalReason: 'watcher_panel_failed',
    }),
  };
  const view = await reconcileWatcherPanelRound(executions, round);
  assert.equal(view.members[0].failure, failure);
  assert.equal(view.members[0].executionStatus, 'failed');
});

test('a legacy quiet entry whose execution was canceled never advances the completed-look cursor', async () => {
  const ledger = new InMemoryWatcherPanelLedger();
  const rounds = [
    { roundId: 'old', cutoffAt: 10, createdAt: 10, id: 'completed' },
    { roundId: 'canceled', cutoffAt: 90, createdAt: 90, id: 'stopped' },
  ];
  for (const row of rounds)
    await ledger.save({
      v: 1,
      roundId: row.roundId,
      userId: 'u',
      threadId: 't',
      sourceInvocationId: 's',
      sourceSettledSequence: 1,
      workerCatId: 'codex',
      cutoffMessageId: 'm',
      cutoffAt: row.cutoffAt,
      createdAt: row.createdAt,
      updatedAt: row.createdAt,
      status: 'completed',
      guidanceDigest: 'sha256:test',
      members: [{ catId: 'gpt52', label: '甲', status: 'quiet', invocationId: row.id, sessionId: 'session' }],
    });
  const executions = {
    get: async (id) => ({
      invocationId: id,
      userId: 'u',
      threadId: 't',
      catId: 'gpt52',
      executionKind: 'watcher',
      causal: { watcherPanelRoundId: id === 'stopped' ? 'canceled' : 'old' },
      status: id === 'stopped' ? 'canceled' : 'succeeded',
      terminalReason: id === 'stopped' ? 'user_cancel' : 'watcher_panel_quiet',
    }),
    listSettled: async () => ({ records: [] }),
  };
  const previous = await watcherPanelPrevious(
    { ledger, executions },
    {
      userId: 'u',
      threadId: 't',
      settledSequence: 3,
    },
    'gpt52',
    'current',
  );
  assert.equal(previous.cutoffAt, 10);
  assert.equal((await ledger.get('canceled')).members[0].status, 'quiet', 'raw ledger is preserved');
});
