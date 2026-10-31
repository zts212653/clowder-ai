import type { VideoProjectFrozenInput, VideoProjectSelfReview } from '@cat-cafe/shared';
import { expect, it } from 'vitest';
import { projectReviewCounts } from '../video-project/review-counts';
import { comparisonShot, comparisonSide } from './compare-screening.fixture';

// Synthetic, already-authenticated facts isolate this consumer; API admission is tested separately.
const side = comparisonSide('old', [comparisonShot('shot-1', 0, 100), comparisonShot('shot-2', 100, 100)]);
const input = side.screening.input;
function fact(
  id: string,
  segmentIds: string[],
  conclusion: VideoProjectSelfReview['conclusion'] = 'pass',
  source: VideoProjectFrozenInput = input,
): VideoProjectSelfReview {
  return {
    id,
    input: source,
    actor: { kind: 'cat', actorId: 'fixture-cat' },
    at: '2026-10-10T15:00:00.000Z',
    operationId: `self-review:${id}`,
    segmentIds,
    conclusion,
    refs: [`fixture:review:${id}`],
  };
}
function counts(facts?: VideoProjectSelfReview[]) {
  return projectReviewCounts({ ...side.input.document, ...(facts ? { selfReviews: facts } : {}) }, input);
}
it('reports zero unknown reviews when a movie exists without a recorded attestation', () => {
  expect(counts()).toEqual({ reviewed: 0, hasRecords: false });
  expect(counts([])).toEqual({ reviewed: 0, hasRecords: false });
});
it('counts only explicit segment passes for partial and full self-review', () => {
  expect(counts([fact('partial', ['shot-1'])])).toEqual({ reviewed: 1, hasRecords: true });
  expect(counts([fact('full', ['shot-1', 'shot-2'])])).toEqual({ reviewed: 2, hasRecords: true });
});
it('keeps a recorded unsuccessful review distinguishable from no records', () => {
  expect(counts([fact('needs-edit', ['shot-1', 'shot-2'], 'changes-requested')])).toEqual({
    reviewed: 0,
    hasRecords: true,
  });
});
it('deduplicates segment evidence and applies the latest recorded conclusion per segment', () => {
  expect(counts([fact('one', ['shot-1']), fact('two', ['shot-1', 'shot-2'])]).reviewed).toBe(2);
  expect(counts([fact('one', ['shot-1', 'shot-2']), fact('two', ['shot-1'], 'changes-requested')]).reviewed).toBe(1);
  expect(counts([fact('one', ['shot-1'], 'changes-requested'), fact('two', ['shot-1'])]).reviewed).toBe(1);
});
it.each([
  { ...input, contentRef: 'another-project' },
  { ...input, ownerRevision: input.ownerRevision + 1 },
  { ...input, blobDigest: `sha256:${'f'.repeat(64)}` },
])('does not borrow evidence from a different frozen input %j', (source) => {
  expect(counts([fact('wrong-source', ['shot-1', 'shot-2'], 'pass', source)])).toEqual({
    reviewed: 0,
    hasRecords: false,
  });
});
it('uses the selected frozen segment IDs when the current head has deleted a reviewed shot', () => {
  const head = structuredClone(side.input.document);
  head.timeline.segments = [head.timeline.segments[1]];
  head.selfReviews = [fact('old-complete', ['shot-1', 'shot-2'])];
  expect(projectReviewCounts(head, input, side.input.document)).toEqual({ reviewed: 2, hasRecords: true });
  expect(projectReviewCounts(head, input)).toEqual({ reviewed: 1, hasRecords: true });
});
it('never grows an old screening count from a newly inserted head shot', () => {
  const head = structuredClone(side.input.document);
  head.timeline.segments.push(comparisonShot('head-only-shot', 200, 100));
  head.selfReviews = [fact('head', ['head-only-shot'], 'pass', { ...input, ownerRevision: 3 })];
  expect(projectReviewCounts(head, input, side.input.document)).toEqual({ reviewed: 0, hasRecords: false });
});
