import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectiveContentScopeRef } from '../src/domains/video-studio/content-owner/collective-scope.js';
import {
  custodyAuthority,
  custodyModification,
  custodyTransfer,
  emptyCustodyOwner,
} from './collective-custody-transfer.fixture.js';
import { baseConstraint, fixture, scope, text } from './collective-markdown.fixture.js';

test('preparation terminalizes unresolved requests without waiting for remote compute and rejects every late effect', async (t) => {
  const f = await fixture(t);
  const { command, agent } = await custodyModification(f, 'unresolved-before-transfer');
  let transfer = await custodyTransfer(f.owner);
  const authority = custodyAuthority(() => transfer, 'source');
  assert.ok(f.port.custody);
  const prepared = await f.port.custody.prepareSource(transfer, authority);
  const scopeRef = collectiveContentScopeRef(scope);
  const record = f.modifications.requests.collective.get(command.requestId, scopeRef);
  assert.equal(record?.state, 'unavailable');
  assert.deepEqual(record?.transferOutcome, {
    reason: 'custody_transferred',
    transferId: transfer.transferId,
    sourceCustodyRevision: 1,
  });
  assert.deepEqual(await f.port.custody.prepareSource(transfer, authority), prepared);
  assert.deepEqual(f.modifications.requests.collective.get(command.requestId, scopeRef), record);
  transfer = { ...transfer, state: 'source_prepared', prepared };
  // These are late effect attempts, regardless of when an external Queue/Registry started computing.
  const before = f.modifications.collectiveCustody.exportSnapshot(scopeRef, scope.contentRef);
  for (const phase of ['already-computing', 'queued', 'started-after-prepared']) {
    const result = await f.execute(
      { ...baseConstraint, action: 'propose', agent, effectMode: 'replay_only' },
      command,
      phase,
    );
    assert.equal(result.status, 'error');
  }
  assert.deepEqual(f.modifications.collectiveCustody.exportSnapshot(scopeRef, scope.contentRef), before);
  const read = await f.execute(baseConstraint);
  assert.equal(read.status, 'ok');
  if (read.status === 'ok') assert.equal(read.value.modifications.requests[0].unavailableReason, 'custody_transferred');
});

test('a frozen committed proposal replays exactly, rejects new operations and remains adoptable after complete transfer', async (t) => {
  const f = await fixture(t);
  const target = await emptyCustodyOwner(t);
  const { command, agent } = await custodyModification(f, 'proposal-before-transfer');
  const constraint = { ...baseConstraint, action: 'propose' as const, agent };
  const proposed = await f.execute(constraint, command, 'original-proposal');
  assert.equal(proposed.status, 'ok', f.errors.map(String).join('\n'));
  if (proposed.status !== 'ok') return;
  let transfer = await custodyTransfer(f.owner);
  const sourceAuthority = custodyAuthority(() => transfer, 'source');
  const targetAuthority = custodyAuthority(() => transfer, 'target');
  assert.ok(f.port.custody);
  const prepared = await f.port.custody.prepareSource(transfer, sourceAuthority);
  transfer = { ...transfer, state: 'source_prepared', prepared };
  const scopeRef = collectiveContentScopeRef(scope);
  const before = f.modifications.collectiveCustody.exportSnapshot(scopeRef, scope.contentRef);
  const replay = await f.execute({ ...constraint, effectMode: 'replay_only' }, command, 'lost-proposal-reply');
  assert.equal(replay.status, 'ok');
  if (replay.status === 'ok') assert.deepEqual(replay.value, proposed.value);
  const newOperation = await f.execute(
    { ...constraint, effectMode: 'replay_only' },
    { ...command, operationId: '00000000-0000-4000-8000-000000000030', expectedProposalRevision: 1 },
    'late-new-operation',
  );
  assert.equal(newOperation.status, 'error');
  assert.deepEqual(f.modifications.collectiveCustody.exportSnapshot(scopeRef, scope.contentRef), before);
  assert.ok(target.current.root.custody);
  for (let index = 0; index < prepared.manifest.pageCount; index++)
    await target.current.root.custody.stageTarget(
      transfer,
      await f.port.custody.readPage(transfer, index, sourceAuthority),
      targetAuthority,
    );
  const ready = await target.current.root.custody.attestReady(transfer, targetAuthority);
  transfer = { ...transfer, state: 'committed', ready };
  await f.port.custody.finalize(transfer, sourceAuthority);
  await target.current.root.custody.finalize(transfer, targetAuthority);
  target.reopen();
  const current = { ...baseConstraint, action: 'apply' as const, custodyRevision: 2, humanId: 'human-bob' };
  const operation = {
    relayRef: 'adopt-at-target',
    requestId: 'adopt-at-target',
    constraint: current,
    payload: { requestId: command.requestId, proposalRef: proposed.value.proposal.proposalRef },
    expiresAt: Date.now() + 10000,
  };
  const adopted = await target.current.root.execute(operation, { reauthorize: async () => current });
  assert.equal(adopted.status, 'ok');
  if (adopted.status === 'ok') assert.equal(adopted.value.receipt.ownerRevision, 2);
  assert.deepEqual(await target.current.root.execute(operation, { reauthorize: async () => current }), adopted);
  assert.equal(
    (await target.current.owner.load(scope.contentRef)).bytes.toString('utf8'),
    text.replace('unique', 'clear'),
  );
  assert.equal((await target.current.owner.listOutbox(scope.contentRef)).length, 2);
  assert.equal((await f.execute(constraint, command, 'post-commit-old-replay')).status, 'error');
});
