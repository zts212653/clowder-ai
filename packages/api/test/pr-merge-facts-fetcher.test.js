import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { fetchPrMergeFacts } from '../dist/infrastructure/github/pr-merge-facts-fetcher.js';

function ghFixture({ mergeStateStatus, behindBy }) {
  const commands = [];
  return {
    commands,
    async execFileAsync(file, args) {
      assert.equal(file, 'gh');
      commands.push([...args]);
      if (args[0] === 'pr') {
        return {
          stdout: JSON.stringify({
            mergeable: 'CONFLICTING',
            mergeStateStatus,
            baseRefOid: 'a'.repeat(40),
            headRefOid: 'b'.repeat(40),
          }),
        };
      }
      if (args[0] === 'api') {
        return { stdout: String(behindBy) };
      }
      throw new Error(`unexpected gh command: ${args.join(' ')}`);
    },
  };
}

describe('fetchPrMergeFacts', () => {
  test('uses compare ancestry when DIRTY masks a behind head', async () => {
    const fixture = ghFixture({ mergeStateStatus: 'DIRTY', behindBy: 5 });
    const facts = await fetchPrMergeFacts('owner/repo', 7, fixture);

    assert.equal(facts.mergeStateStatus, 'DIRTY');
    assert.equal(facts.isBehind, true);
    assert.deepEqual(fixture.commands[1].slice(0, 2), [
      'api',
      `/repos/owner/repo/compare/${'a'.repeat(40)}...${'b'.repeat(40)}`,
    ]);
    assert.deepEqual(fixture.commands[1].slice(-2), ['--jq', '.behind_by']);
  });

  test('clears behind when BLOCKED masks a head that caught up', async () => {
    const fixture = ghFixture({ mergeStateStatus: 'BLOCKED', behindBy: 0 });
    const facts = await fetchPrMergeFacts('owner/repo', 7, fixture);

    assert.equal(facts.mergeStateStatus, 'BLOCKED');
    assert.equal(facts.isBehind, false);
  });

  test('fails closed when GitHub omits an exact comparison ref', async () => {
    await assert.rejects(
      fetchPrMergeFacts('owner/repo', 7, {
        async execFileAsync() {
          return {
            stdout: JSON.stringify({
              mergeable: 'MERGEABLE',
              mergeStateStatus: 'CLEAN',
              baseRefOid: 'a'.repeat(40),
            }),
          };
        },
      }),
      /exact base\/head unavailable/,
    );
  });

  test('fails closed when the comparison has no numeric behind count', async () => {
    const fixture = ghFixture({ mergeStateStatus: 'CLEAN', behindBy: 'unknown' });
    await assert.rejects(fetchPrMergeFacts('owner/repo', 7, fixture), /behind_by unavailable/);
  });
});
