import { expect, it, vi } from 'vitest';
import type { UnifiedAttentionView } from '../../use-unified-attention';
import { historyReadState } from '../history-read-state';
import { okRead } from './mailbox-fixtures';

function view(): UnifiedAttentionView {
  const result = okRead([]);
  if (result.kind !== 'ok') throw new Error('fixture');
  const source = { status: 'available' as const, exhaustiveness: 'complete' as const, startedAt: 1, observedAt: 2 };
  result.read.sources.userMentions = { ...source, coverage: 'explicit_user_mentions' };
  result.read.sources.personalPreferences = { ...source, coverage: 'owner_personal_ignored_items' };
  return { result, staleRead: null, refetch: vi.fn(), readsStarted: () => 1, resultGeneration: 1 };
}
it('does not claim empty when a relevant history source fails, even with a successful approval page', () => {
  const v = view();
  if (v.result.kind !== 'ok') throw new Error('fixture');
  v.result.read.sources.userMentions!.status = 'unavailable';
  expect(historyReadState('mentions', null, v)).toMatchObject({ failed: true, canClaimEmpty: false });
});
it('ignored and mention history do not depend on the separate approval page', () => {
  expect(historyReadState('ignored', null, view())).toMatchObject({
    reading: false,
    failed: false,
    canClaimEmpty: true,
  });
  expect(historyReadState('mentions', null, view())).toMatchObject({
    reading: false,
    failed: false,
    canClaimEmpty: true,
  });
});
it('keeps the cached read timestamp on a failed history refresh', () => {
  const v = view();
  v.staleRead = v.result.kind === 'ok' ? v.result.read : null;
  v.result = { kind: 'failed', reason: 'unavailable' };
  expect(historyReadState('mentions', null, v)).toMatchObject({ failed: true, observedAt: 2, canClaimEmpty: false });
});
