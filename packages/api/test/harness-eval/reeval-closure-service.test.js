import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import {
  projectReevalClosure,
  ReevalClosureProjectionError,
} from '../../dist/infrastructure/harness-eval/reeval-closure.js';
import { ReevalClosureCommandError } from '../../dist/infrastructure/harness-eval/reeval-closure-service.js';
import { command, createServiceHarness, opened, ref, root } from './reeval-closure-service-fixtures.js';

describe('eval verdict lifecycle command service', () => {
  let eventLog;
  let roots;
  let service;

  beforeEach(async () => {
    ({ eventLog, roots, service } = await createServiceHarness());
  });

  it('materializes the deterministic opener before the first writeback', async () => {
    eventLog.events.clear();
    eventLog.seen.clear();

    const result = await service.execute({ kind: 'cat', id: 'codex-sol' }, command('acknowledge', 'first-ack', 0));

    assert.equal(result.outcome, 'appended');
    assert.equal(result.projection.status, 'acknowledged');
    assert.deepEqual(
      (await eventLog.read(root.verdictId)).map((event) => event.type),
      ['verdict_opened', 'owner_acknowledged'],
    );
  });

  it('retries safely after a crash persisted only the deterministic opener', async () => {
    const result = await service.execute(
      { kind: 'cat', id: 'codex-sol' },
      command('acknowledge', 'ack-after-opener-crash', 0),
    );

    assert.equal(result.outcome, 'appended');
    assert.equal(result.projection.sequence, 2);
    assert.equal((await eventLog.read(root.verdictId)).length, 2);
  });

  it('converges when the reconciler wins the deterministic opener race', async () => {
    eventLog.events.clear();
    eventLog.seen.clear();
    const append = eventLog.append.bind(eventLog);
    let raced = false;
    eventLog.append = async (event, expectedSequence) => {
      if (event.type !== 'verdict_opened' || raced) return append(event, expectedSequence);
      raced = true;
      await append(event, expectedSequence);
      return { outcome: 'duplicate' };
    };

    const result = await service.execute(
      { kind: 'cat', id: 'codex-sol' },
      command('acknowledge', 'ack-after-reconciler-race', 0),
    );

    assert.equal(result.outcome, 'appended');
    assert.deepEqual(
      (await eventLog.read(root.verdictId)).map((event) => event.type),
      ['verdict_opened', 'owner_acknowledged'],
    );
  });

  it('serializes two concurrent first writebacks behind one opener', async () => {
    eventLog.events.clear();
    eventLog.seen.clear();

    const results = await Promise.all([
      service.execute({ kind: 'cat', id: 'codex-sol' }, command('acknowledge', 'first-a', 0)),
      service.execute({ kind: 'cat', id: 'codex-sol' }, command('acknowledge', 'first-b', 0)),
    ]);

    assert.deepEqual(results.map((result) => result.outcome).sort(), ['appended', 'conflict']);
    const events = await eventLog.read(root.verdictId);
    assert.equal(events.filter((event) => event.type === 'verdict_opened').length, 1);
    assert.equal(events.filter((event) => event.type === 'owner_acknowledged').length, 1);
  });

  it('fails closed when stored history diverges from the canonical bootstrap prefix', async () => {
    eventLog.events.set(root.verdictId, [opened({ reason: 'non-canonical opener' })]);

    await assert.rejects(
      service.execute({ kind: 'cat', id: 'codex-sol' }, command('acknowledge', 'ack-after-divergence', 1)),
      (error) => error instanceof ReevalClosureProjectionError && error.code === 'invalid_history',
    );
  });

  it('constructs trusted actors server-side and rejects caller-authored authority fields', async () => {
    const result = await service.execute({ kind: 'cat', id: 'codex-sol' }, command('acknowledge', 'ack-1', 1));
    assert.equal(result.outcome, 'appended');
    assert.deepEqual(result.projection.history.at(-1).actor, { kind: 'cat', id: 'codex-sol' });

    for (const extra of [
      { actor: { kind: 'cvo', id: 'you' } },
      { actorOverride: { kind: 'cvo', id: 'you' } },
      { assignedEvalCatId: 'spoofed-eval' },
    ]) {
      await assert.rejects(
        service.execute(
          { kind: 'cat', id: 'codex-sol' },
          command('plan_action', `spoof-${Object.keys(extra)[0]}`, 2, extra),
        ),
        ReevalClosureCommandError,
      );
    }
  });

  it('records the complete fix plus verified re-evaluation path', async () => {
    const acknowledgement = await service.execute({ kind: 'cat', id: 'codex-sol' }, command('acknowledge', 'ack', 1));
    assert.equal(acknowledgement.projection.status, 'acknowledged');

    const planned = await service.execute(
      { kind: 'cat', id: 'codex-sol' },
      command('plan_action', 'plan', 2, { refs: [ref('plan', 'task:f266')] }),
    );
    assert.equal(planned.projection.status, 'action_planned');

    const fixed = await service.execute(
      { kind: 'cat', id: 'codex-sol' },
      command('record_fix', 'fix', 3, { refs: [ref('commit', '50ec90163')] }),
    );
    assert.equal(fixed.projection.status, 'fix_landed');

    const pending = await service.execute(
      { kind: 'cat', id: 'codex-sol' },
      command('request_reeval', 'request', 4, {
        refs: [ref('reeval', 'eval:capability-wakeup:2026-07-19')],
      }),
    );
    assert.equal(pending.projection.status, 'reeval_pending');

    const resolved = await service.execute(
      { kind: 'cat', id: 'gpt52' },
      command('record_reeval_result', 'pass', 5, {
        result: 'passed',
        refs: [ref('reeval', 'docs/verdicts/2026-07-19-reeval.md')],
      }),
    );
    assert.equal(resolved.projection.status, 'resolved');
  });

  it('pins eval authority per cycle when registry assignment changes', async () => {
    await service.execute({ kind: 'cat', id: 'codex-sol' }, command('acknowledge', 'ack', 1));
    await service.execute({ kind: 'cat', id: 'codex-sol' }, command('plan_action', 'plan-a', 2));
    await service.execute({ kind: 'cat', id: 'codex-sol' }, command('record_fix', 'fix-a', 3));

    const firstRequest = command('request_reeval', 'request-a', 4);
    const pending = await service.execute({ kind: 'cat', id: 'codex-sol' }, firstRequest);
    assert.equal(pending.projection.history.at(-1).assignedEvalCatId, 'gpt52');

    roots.set(root.verdictId, { ...root, assignedEvalCatId: 'registry-eval' });
    const duplicateRequest = await service.execute(
      { kind: 'cat', id: 'codex-sol' },
      { ...firstRequest, expectedSequence: 0 },
    );
    assert.equal(duplicateRequest.outcome, 'duplicate');

    const firstResult = command('record_reeval_result', 'result-a', 5, { result: 'failed' });
    const failed = await service.execute({ kind: 'cat', id: 'gpt52' }, firstResult);
    assert.equal(failed.projection.status, 'action_planned');
    assert.equal(failed.projection.reevalAssignedCatId, 'gpt52');

    await service.execute({ kind: 'cat', id: 'codex-sol' }, command('record_fix', 'fix-b', 6));
    await service.execute({ kind: 'cat', id: 'codex-sol' }, command('request_reeval', 'request-b', 7));
    roots.set(root.verdictId, { ...root, assignedEvalCatId: 'future-eval' });

    const secondResult = command('record_reeval_result', 'result-b', 8, { result: 'passed' });
    const resolved = await service.execute({ kind: 'cat', id: 'registry-eval' }, secondResult);
    assert.equal(resolved.projection.status, 'resolved');
    assert.equal(resolved.projection.reevalAssignedCatId, 'registry-eval');

    const events = await eventLog.read(root.verdictId);
    assert.deepEqual(
      events
        .filter((event) => ['reeval_requested', 'reeval_failed', 'reeval_passed'].includes(event.type))
        .map((event) => event.assignedEvalCatId),
      ['gpt52', 'gpt52', 'registry-eval', 'registry-eval'],
    );
    assert.equal(projectReevalClosure(roots.get(root.verdictId), events).status, 'resolved');

    const duplicateResult = await service.execute(
      { kind: 'cat', id: 'registry-eval' },
      { ...secondResult, expectedSequence: 0 },
    );
    assert.equal(duplicateResult.outcome, 'duplicate');
  });

  it('matches a raced duplicate against the winning event authority', async () => {
    await service.execute({ kind: 'cat', id: 'codex-sol' }, command('acknowledge', 'ack', 1));
    await service.execute({ kind: 'cat', id: 'codex-sol' }, command('plan_action', 'plan', 2));
    await service.execute({ kind: 'cat', id: 'codex-sol' }, command('record_fix', 'fix', 3));
    roots.set(root.verdictId, { ...root, assignedEvalCatId: 'registry-eval' });

    const append = eventLog.append.bind(eventLog);
    eventLog.append = async (event, expectedSequence) => {
      if (event.eventId !== 'raced-request') return append(event, expectedSequence);
      await append({ ...event, assignedEvalCatId: 'gpt52' }, expectedSequence);
      return { outcome: 'duplicate' };
    };

    const duplicate = await service.execute(
      { kind: 'cat', id: 'codex-sol' },
      command('request_reeval', 'raced-request', 4),
    );
    assert.equal(duplicate.outcome, 'duplicate');
    assert.equal(duplicate.projection.reevalAssignedCatId, 'gpt52');
  });

  it('refuses to create a new re-evaluation cycle without trusted eval authority', async () => {
    await service.execute({ kind: 'cat', id: 'codex-sol' }, command('acknowledge', 'ack', 1));
    await service.execute({ kind: 'cat', id: 'codex-sol' }, command('plan_action', 'plan', 2));
    await service.execute({ kind: 'cat', id: 'codex-sol' }, command('record_fix', 'fix', 3));
    roots.set(root.verdictId, { ...root, assignedEvalCatId: undefined });

    await assert.rejects(
      service.execute({ kind: 'cat', id: 'codex-sol' }, command('request_reeval', 'request', 4)),
      (error) => error instanceof ReevalClosureCommandError && error.code === 'eval_authority_unavailable',
    );
  });

  it('preserves owner continuity until an audited reassignment', async () => {
    await service.execute({ kind: 'cat', id: 'codex-sol' }, command('acknowledge', 'ack', 1));

    await assert.rejects(
      service.execute({ kind: 'cat', id: 'opus' }, command('plan_action', 'impersonated-plan', 2)),
      ReevalClosureProjectionError,
    );

    const reassigned = await service.execute(
      { kind: 'cvo', id: 'you' },
      command('reassign_owner', 'reassign', 2, {
        targetOwnerCatId: 'opus',
        refs: [ref('message', 'thread:audited-reassignment')],
      }),
    );
    assert.equal(reassigned.projection.targetOwnerCatId, 'opus');

    const planned = await service.execute({ kind: 'cat', id: 'opus' }, command('plan_action', 'new-owner-plan', 3));
    assert.equal(planned.projection.lifecycleOwnerCatId, 'opus');
  });

  it('fails illegal transitions before append and reports concurrent CAS conflicts', async () => {
    await assert.rejects(
      service.execute({ kind: 'cat', id: 'codex-sol' }, command('record_fix', 'too-early', 1)),
      ReevalClosureProjectionError,
    );
    assert.equal((await eventLog.read(root.verdictId)).length, 1);

    await service.execute({ kind: 'cat', id: 'codex-sol' }, command('acknowledge', 'ack', 1));
    const results = await Promise.all([
      service.execute({ kind: 'cat', id: 'codex-sol' }, command('plan_action', 'plan-a', 2)),
      service.execute({ kind: 'cat', id: 'codex-sol' }, command('plan_action', 'plan-b', 2)),
    ]);
    assert.deepEqual(results.map((result) => result.outcome).sort(), ['appended', 'conflict']);
  });

  it('returns an idempotent duplicate after later transitions without regressing state', async () => {
    const acknowledgement = command('acknowledge', 'ack-once', 1);
    await service.execute({ kind: 'cat', id: 'codex-sol' }, acknowledgement);
    await service.execute({ kind: 'cat', id: 'codex-sol' }, command('plan_action', 'plan', 2));

    const duplicate = await service.execute(
      { kind: 'cat', id: 'codex-sol' },
      { ...acknowledgement, expectedSequence: 0 },
    );
    assert.equal(duplicate.outcome, 'duplicate');
    assert.equal(duplicate.projection.status, 'action_planned');
    assert.equal(duplicate.projection.history.filter((event) => event.eventId === 'ack-once').length, 1);
  });

  it('fails closed on forbidden automation, operator, cat, and unknown verbs', async () => {
    await service.execute({ kind: 'cat', id: 'codex-sol' }, command('acknowledge', 'ack', 1));
    await service.execute({ kind: 'cat', id: 'codex-sol' }, command('plan_action', 'plan', 2));

    for (const [principal, attempted] of [
      [{ kind: 'automation', id: 'reconciler' }, command('record_fix', 'automation-fix', 3)],
      [{ kind: 'cvo', id: 'you' }, command('record_fix', 'cvo-fix', 3)],
      [{ kind: 'cat', id: 'codex-sol' }, command('suppress', 'cat-suppress', 3)],
      [{ kind: 'automation', id: 'reconciler' }, command('suppress', 'automation-suppress', 3)],
      [{ kind: 'cat', id: 'codex-sol' }, command('merge_fix', 'merge', 3)],
    ]) {
      await assert.rejects(service.execute(principal, attempted));
    }

    const suppressed = await service.execute(
      { kind: 'cvo', id: 'you' },
      command('suppress', 'cvo-suppress', 3, { reason: 'operator accepts the measured tradeoff' }),
    );
    assert.equal(suppressed.projection.status, 'suppressed_with_reason');
  });

  it('detects a global event-id collision instead of misreporting another verdict as duplicate success', async () => {
    const otherRoot = { ...root, verdictId: 'verdict-b', domainId: 'eval:capability-tips' };
    roots.set(otherRoot.verdictId, otherRoot);
    await eventLog.append(
      opened({ eventId: 'open-verdict-b', verdictId: otherRoot.verdictId, domainId: otherRoot.domainId }),
      0,
    );
    await service.execute({ kind: 'cat', id: 'codex-sol' }, command('acknowledge', 'shared-id', 1));

    await assert.rejects(
      service.execute(
        { kind: 'cat', id: 'codex-sol' },
        command('acknowledge', 'shared-id', 1, { verdictId: otherRoot.verdictId }),
      ),
      (error) => error instanceof ReevalClosureCommandError && error.code === 'idempotency_collision',
    );

    assert.equal(projectReevalClosure(otherRoot, await eventLog.read(otherRoot.verdictId)).status, 'open');
  });
});
