import { expect, it } from 'vitest';
import { matchingThreadProposal } from '../thread-proposal-read';
import { OWNER, storeItem } from './mailbox-fixtures';

const detail = {
  title: '调查',
  reason: '请先核对证据',
  parentThreadId: 'source',
  projectPath: '/isolated',
  preferredCats: ['codex61-sol'],
  initialMessage: '请调查',
  reportingMode: 'final-only',
};
const item = storeItem({ inlineApprovable: false, detail });
const proposal = {
  ...detail,
  sourceThreadId: 'source',
  sourceCatId: item.requesterCatId,
  proposalId: item.proposalId,
  createdBy: OWNER,
  createdAt: item.createdAt,
  status: 'pending',
};
it('reads the original as-proposed contract without upgrading the generic inline capability', () => {
  expect(matchingThreadProposal(proposal, item)).toEqual(proposal);
  expect(item.inlineApprovable).toBe(false);
});
it.each([
  { createdBy: 'another-owner' },
  { createdAt: 2 },
  { sourceCatId: 'another-cat' },
  { status: 'approved' },
  { preferredCats: ['codex-sol'] },
  { reason: '变了' },
  { reportingMode: 'unknown' },
  { declaredWorkMode: 'unknown' },
  { declaredWorkMode: { toString: 'parallel' } },
  { reportingMode: { toString: 'none' } },
  { preferredCats: [''] },
  { publication: { state: 'staged' } },
  { approvedDevelopmentScope: {} },
  { subjectTaskTitle: {} },
])('refuses an unverified owner, version, publication or contract: %j', (change) => {
  expect(matchingThreadProposal({ ...proposal, ...change }, item)).toBeNull();
});

const developmentScope = {
  featureRef: 'feature:F322',
  phaseKey: 'S3',
  workUnitRef: 'feature-phase:F322:S3',
  acceptedSourceRef: 'file:docs/features/F322-everyday-work-experience.md',
  acceptedRevision: 'a'.repeat(40),
};
it('accepts the complete canonical development scope', () => {
  const scoped = { ...proposal, approvedDevelopmentScope: developmentScope };
  expect(matchingThreadProposal(scoped, item)).toEqual(scoped);
});
it.each([
  { acceptedSourceRef: undefined },
  { featureRef: 'feature:not-a-feature' },
  { phaseKey: 'invalid phase' },
  { workUnitRef: 'feature-phase:F322:OTHER' },
  { acceptedRevision: 'not-a-40-hex-revision' },
  { acceptedSourceRef: 'unanchored prose' },
  { extraAuthority: 'grant' },
])('locks a partially readable but invalid development scope: %j', (change) => {
  expect(
    matchingThreadProposal({ ...proposal, approvedDevelopmentScope: { ...developmentScope, ...change } }, item),
  ).toBeNull();
});
