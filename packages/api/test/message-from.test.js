import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { messageFrom, UNPARSEABLE_LEGACY_CONNECTOR_ID } from '../dist/domains/cats/services/stores/message-from.js';

const legacy = (overrides = {}) => ({
  userId: 'owner-1',
  catId: null,
  ...overrides,
});

describe('messageFrom', () => {
  it('uses canonical MessageFrom without re-inferring identity from compatibility projections', () => {
    const from = { kind: 'external', connectorId: 'github', sender: { id: 'octocat', name: 'Octocat' } };
    assert.equal(
      messageFrom(
        legacy({
          from,
          userId: 'system',
          catId: 'system',
          origin: 'briefing',
          source: { connector: 'wrong', label: 'Wrong', icon: 'x' },
        }),
      ),
      from,
    );
  });

  it('projects a legacy connector source, including sender presentation identity', () => {
    assert.deepEqual(
      messageFrom(
        legacy({
          source: {
            connector: 'github',
            label: 'GitHub',
            icon: 'github',
            sender: { id: 'octocat', name: 'Octocat' },
          },
        }),
      ),
      { kind: 'external', connectorId: 'github', sender: { id: 'octocat', name: 'Octocat' } },
    );
  });

  it('keeps an unparseable legacy connector outside user authority', () => {
    assert.deepEqual(messageFrom(legacy({ sourceParseFailure: true })), {
      kind: 'external',
      connectorId: UNPARSEABLE_LEGACY_CONNECTOR_ID,
    });
  });

  it('projects legacy system and briefing rows into explicit system services', () => {
    assert.deepEqual(messageFrom(legacy({ userId: 'scheduler' })), {
      kind: 'system',
      service: 'scheduler',
    });
    assert.deepEqual(messageFrom(legacy({ userId: 'system', catId: 'system' })), {
      kind: 'system',
      service: 'system',
    });
    assert.deepEqual(messageFrom(legacy({ userId: 'owner-1', catId: 'opus', origin: 'briefing' })), {
      kind: 'system',
      service: 'legacy-briefing',
    });
  });

  it('projects remaining legacy cat and user rows without pseudo-user string checks at call sites', () => {
    assert.deepEqual(messageFrom(legacy({ catId: 'opus' })), { kind: 'agent', catId: 'opus' });
    assert.deepEqual(messageFrom(legacy()), { kind: 'user', userId: 'owner-1' });
  });
});
