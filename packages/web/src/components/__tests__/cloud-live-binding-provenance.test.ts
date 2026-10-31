import { isCloudBridgeOutboundReceiptV1 } from '@cat-cafe/shared';
import { expect, it } from 'vitest';
import { unboundTurn } from '../../../test/browser/fixtures/f247-unbound-turn';
import { isLinkedCloudBindingRecoveryNotice, projectCloudBindingRecovery } from '../cloud-binding-recovery';

it.each([
  'sender',
  'source',
  'target',
  'attempt',
  'sent',
  'unknown',
  'generic',
  'hidden',
  'missing-frame',
  'wrong-frame',
  'ambiguous-frame',
])('does not create a live retry carrier or absorb the warning for %s', (change) => {
  const turn = unboundTurn('user', true);
  const [source, frame, warning] = turn;
  const payload = warning.extra!.systemInfo!.payload;
  if (payload.type !== 'cloud_bridge_status') throw new Error('fixture must be a cloud warning');
  const original = payload.outboundReceipt;
  if (!isCloudBridgeOutboundReceiptV1(original)) throw new Error('fixture must carry a typed receipt');
  const receipt = { ...original, sourceSender: { ...original.sourceSender } };
  payload.outboundReceipt = receipt;
  if (change === 'sender') receipt.sourceSender.id = 'someone-else';
  if (change === 'source') receipt.sourceMessageId = 'different-source';
  if (change === 'target') receipt.targetCatId = 'gpt-dot';
  if (change === 'attempt') receipt.dispatchInvocationId = 'old-attempt';
  if (change === 'sent') receipt.status = 'sent';
  if (change === 'unknown') receipt.status = 'unknown';
  if (change === 'generic') payload.reason = 'unavailable';
  if (change === 'hidden') source.visibility = 'whisper';
  if (change === 'missing-frame') turn.splice(1, 1);
  if (change === 'wrong-frame' && frame.lifecycle?.kind === 'response')
    frame.lifecycle = { ...frame.lifecycle, inputMessageIds: ['other-source'] };
  if (change === 'ambiguous-frame') turn.push({ ...frame });
  expect(projectCloudBindingRecovery(source, turn)).toBeUndefined();
  expect(isLinkedCloudBindingRecoveryNotice(warning, turn)).toBe(false);
});

it.each(['user', 'cat'] as const)('a historical retry/source mismatch cannot connect for %s', (author) => {
  const turn = unboundTurn(author, true);
  const [source, frame, warning] = turn;
  if (frame.lifecycle?.kind === 'response') frame.lifecycle = { ...frame.lifecycle, invocationId: 'new-attempt' };
  expect(projectCloudBindingRecovery(source, turn)).toBeUndefined();
  expect(isLinkedCloudBindingRecoveryNotice(warning, turn)).toBe(false);
});

it('does not introduce live recovery in Classic, while keeping its persisted recovery', () => {
  const live = unboundTurn('user', true),
    history = unboundTurn('user');
  expect(projectCloudBindingRecovery(live[0], live, false)).toBeUndefined();
  expect(projectCloudBindingRecovery(history[0], history, false)?.attemptId).toBe('dispatch77');
});
