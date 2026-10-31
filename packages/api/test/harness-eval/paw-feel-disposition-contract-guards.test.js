import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inspectPawFeelMessage } from '../../dist/infrastructure/harness-eval/friction/paw-feel-source.js';
import { PawFeelDispositionReadModel } from '../../dist/infrastructure/harness-eval/paw-feel-disposition/read-model.js';
import { PawFeelDispositionService } from '../../dist/infrastructure/harness-eval/paw-feel-disposition/service.js';
import {
  pawFeelCandidate as candidate,
  pawFeelCommand as command,
  createPawFeelServiceHarness as createHarness,
  MemoryPawFeelEventLog,
  T0,
} from './helpers/paw-feel-disposition-service-fixture.js';

describe('F278 responsibility contract guards', () => {
  it('requires the recovered signer to execute the exact durable candidate', async () => {
    const { eventLog, service } = createHarness();
    const source = candidate({ messageId: 'message-source', sourceCatId: 'codex-sol' });
    const requestedTarget = candidate({ messageId: 'message-target-1', digest: 'b'.repeat(64) });
    const substitutedTarget = candidate({ messageId: 'message-target-2', digest: 'c'.repeat(64) });
    await Promise.all(
      [source, requestedTarget, substitutedTarget].map((entry) => service.discover(entry, { backfilled: false })),
    );
    await service.execute(
      { kind: 'cat', id: 'codex-sol' },
      command('request_signature', source.signalId, 1, {
        eventId: 'signature-exact-candidate',
        action: { type: 'duplicate', duplicateOf: requestedTarget.signalId },
        preferredSignerCatId: 'opus5',
      }),
    );

    await assert.rejects(
      service.execute(
        { kind: 'cat', id: 'opus5' },
        command('mark_duplicate', source.signalId, 2, {
          eventId: 'signature-substituted-candidate',
          duplicateOf: substitutedTarget.signalId,
        }),
      ),
      /does not match the durable signature request/i,
    );
    assert.equal((await eventLog.read(source.signalId)).length, 2);
  });

  it('rejects a preferred signer that is the source cat', async () => {
    const { eventLog, service } = createHarness();
    const source = candidate({ sourceCatId: 'codex-sol' });
    await service.discover(source, { backfilled: false });

    await assert.rejects(
      service.execute(
        { kind: 'cat', id: 'codex-sol' },
        command('request_signature', source.signalId, 1, {
          eventId: 'signature-self-preferred',
          action: { type: 'no_action', reasonCode: 'not_actionable' },
          preferredSignerCatId: 'codex-sol',
        }),
      ),
      /preferred signer must be independent from the source cat/i,
    );
    assert.equal((await eventLog.read(source.signalId)).length, 1);
  });

  it('fails closed when a bundle action has no authoritative membership resolver', async () => {
    const eventLog = new MemoryPawFeelEventLog();
    const service = new PawFeelDispositionService({ eventLog, now: () => new Date(T0).toISOString() });
    const source = candidate();
    await service.discover(source, { backfilled: false });

    await assert.rejects(
      service.executeBundle(
        { kind: 'cat', id: 'opus5' },
        {
          bundleKey: 'signal:unverified',
          membershipToken: 'unverified-token',
          members: [{ signalId: source.signalId, expectedSequence: 1 }],
          action: { type: 'no_action', reasonCode: 'not_actionable' },
          eventIdPrefix: 'unverified-bundle',
        },
      ),
      /require authoritative membership resolution/i,
    );
    assert.equal((await eventLog.read(source.signalId)).length, 1);
  });

  it('executes the exact list snapshot even when a later member joins the live bundle', async () => {
    const message = {
      id: 'message-list-confirm',
      threadId: 'thread-source',
      userId: 'user-1',
      catId: 'codex-sol',
      content: '[爪感差: rg+first]\n[爪感差: find+second]',
      mentions: [],
      timestamp: T0 - 60_000,
    };
    const messageStore = {
      async getById(messageId) {
        return messageId === message.id ? message : null;
      },
    };
    const eventLog = new MemoryPawFeelEventLog();
    const readModel = new PawFeelDispositionReadModel({
      eventLog,
      messageStore,
      now: () => new Date(T0).toISOString(),
    });
    const service = new PawFeelDispositionService({
      eventLog,
      bundleMembershipResolver: readModel,
      now: () => new Date(T0).toISOString(),
    });
    const firstInspection = inspectPawFeelMessage(message);
    assert.equal(firstInspection.kind, 'canonical');
    for (const source of firstInspection.candidates) await service.discover(source, { backfilled: false });

    const listed = await readModel.list({ states: ['new'] });
    assert.equal(listed.bundles.length, 1);
    const bundle = listed.bundles[0];
    assert.equal(bundle.members.length, 2);
    const listedMembers = bundle.members.map((item) => ({
      signalId: item.disposition.signalId,
      expectedSequence: item.disposition.sequence,
    }));

    message.content += '\n[爪感差: sed+late member]';
    const laterInspection = inspectPawFeelMessage(message);
    assert.equal(laterInspection.kind, 'canonical');
    const late = laterInspection.candidates.at(-1);
    await service.discover(late, { backfilled: false });

    const confirmed = await service.executeBundle(
      { kind: 'cat', id: 'opus5' },
      {
        bundleKey: bundle.bundleKey,
        membershipToken: bundle.membershipToken,
        members: listedMembers,
        action: { type: 'no_action', reasonCode: 'not_actionable' },
        eventIdPrefix: 'list-confirm',
      },
    );
    assert.deepEqual(confirmed.counts, { appended: 2, duplicate: 0, conflict: 0, rejected: 0 });
    assert.equal((await eventLog.read(late.signalId)).length, 1);
  });
});
