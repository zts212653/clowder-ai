import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { ReevalClosureCommandError } from '../../dist/infrastructure/harness-eval/reeval-closure-service.js';
import { command, createServiceHarness, root } from './reeval-closure-service-fixtures.js';

describe('eval verdict lifecycle re-evaluation SLA', () => {
  let roots;
  let service;

  beforeEach(async () => {
    ({ roots, service } = await createServiceHarness());
    await service.execute({ kind: 'cat', id: 'codex-sol' }, command('acknowledge', 'ack', 1));
    await service.execute({ kind: 'cat', id: 'codex-sol' }, command('plan_action', 'plan', 2));
    await service.execute({ kind: 'cat', id: 'codex-sol' }, command('record_fix', 'fix', 3));
  });

  it('derives the deadline from trusted domain SLA and rejects caller overrides', async () => {
    await assert.rejects(
      service.execute(
        { kind: 'cat', id: 'codex-sol' },
        command('request_reeval', 'caller-deadline', 4, { dueAt: '2036-07-18T00:00:00.000Z' }),
      ),
      (error) => error instanceof ReevalClosureCommandError && error.code === 'invalid_command',
    );

    const pending = await service.execute(
      { kind: 'cat', id: 'codex-sol' },
      command('request_reeval', 'server-deadline', 4),
    );
    const requested = pending.projection.history.at(-1);
    assert.equal(requested.type, 'reeval_requested');
    assert.equal(
      requested.dueAt,
      new Date(Date.parse(requested.occurredAt) + root.reevalWithinHours * 3_600_000).toISOString(),
    );
  });

  it('fails closed when the canonical domain SLA is unavailable', async () => {
    roots.set(root.verdictId, { ...root, reevalWithinHours: undefined });

    await assert.rejects(
      service.execute({ kind: 'cat', id: 'codex-sol' }, command('request_reeval', 'missing-sla', 4)),
      (error) => error instanceof ReevalClosureCommandError && error.code === 'reeval_sla_unavailable',
    );
  });

  it('reuses the immutable deadline when policy changes before an idempotent retry', async () => {
    const request = command('request_reeval', 'stable-deadline', 4);
    const pending = await service.execute({ kind: 'cat', id: 'codex-sol' }, request);
    const firstDueAt = pending.projection.reevalDueAt;

    roots.set(root.verdictId, { ...root, reevalWithinHours: 72 });
    const duplicate = await service.execute({ kind: 'cat', id: 'codex-sol' }, { ...request, expectedSequence: 0 });

    assert.equal(duplicate.outcome, 'duplicate');
    assert.equal(duplicate.projection.reevalDueAt, firstDueAt);
  });
});
