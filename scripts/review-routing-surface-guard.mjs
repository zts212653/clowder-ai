function requireTokens(source, label, tokens) {
  return tokens.filter((token) => !source.includes(token)).map((token) => `${label} is missing ${token}.`);
}

export function checkReviewContinuityLanguage({ ironLaw, requestReview, mergeGate, inboundPr }) {
  const errors = [];
  if (/Review 必须跨个体/.test(ironLaw) && !/已选择 Review 时必须跨个体/.test(ironLaw)) {
    errors.push('iron law turns conditional review selection into a universal review obligation.');
  }
  if (/有 diff 的交付至少一个非作者/.test(requestReview)) {
    errors.push('request-review forces every diff to pay an independent-review tax.');
  }
  if (/(?:任何|每次).{0,16}(?:push|HEAD).{0,24}(?:失效|重审|re-review)/i.test(mergeGate)) {
    errors.push('merge-gate treats SHA movement as automatic review invalidation.');
  }
  if (/只要 HEAD 变化，就不能默认沿用旧 review/.test(inboundPr)) {
    errors.push('inbound PR guidance makes SHA movement the primary review boundary.');
  }
  return errors;
}

export function checkReviewRoutingSurfaces({
  handoffSkill,
  requestReviewSkill,
  receiveReviewSkill,
  mergeGateSkill,
  ironLaw,
  inboundPrReference,
  trackerToolSource,
  capabilityWakeupDomain,
  capabilityWakeupFixture,
}) {
  const errors = [
    ...requireTokens(handoffSkill, 'cross-cat-handoff convention', [
      'Review Completion Intent Classifier',
      'author/custody/handoff source',
      'cat_cafe_record_external_review_verdict',
      'pending_delivery',
      'delivery proof',
      'exact target evidence',
      'author cat route',
      'Review Entry Mode Classifier',
      'reviewMode=formal',
      'advisory_read_only',
      'no-comment',
      'task/tracker',
      'review-complete',
      'ordinary durable A2A',
      'localReviewVerdict',
      'reviewedHeadSha',
    ]),
    ...requireTokens(requestReviewSkill, 'request-review convention', [
      'author/custody/handoff source',
      'author cat route',
      'merge-gate、repository rule 或 operator',
      'Review Entry Mode Classifier',
      'advisory_read_only',
      'no-comment',
      'review-complete',
      'ordinary durable A2A',
      'localReviewVerdict',
      'reviewedHeadSha',
    ]),
    ...requireTokens(receiveReviewSkill, 'receive-review re-entry convention', [
      'request-review',
      '普通 durable A2A',
      'localReviewVerdict',
      'reviewedHeadSha',
    ]),
    ...requireTokens(mergeGateSkill, 'merge-gate review provenance convention', [
      'already-consumed exact-HEAD review',
      'durable local review fact',
      'localReviewVerdict',
      'reviewedHeadSha',
      'no new information',
      '机械三方合并',
    ]),
    ...checkReviewContinuityLanguage({
      ironLaw,
      requestReview: requestReviewSkill,
      mergeGate: mergeGateSkill,
      inboundPr: inboundPrReference,
    }),
    ...requireTokens(trackerToolSource, 'register_pr_tracking description', [
      'Review Entry Mode Classifier',
      'advisory_read_only',
      'no-comment',
      'review-complete',
    ]),
    ...requireTokens(capabilityWakeupDomain, 'capability-wakeup domain', [
      'external-pr-review-route-classifier',
      'docs/harness-feedback/fixtures/external-pr-review-route-classifier.md',
    ]),
    ...requireTokens(capabilityWakeupFixture, 'capability-wakeup fixture', [
      'exact-HEAD',
      'PR tracking',
      'advisory_read_only',
      'cross-cat-handoff',
    ]),
  ];
  if (requestReviewSkill.includes('标准做法是 reviewer 用 PR comment')) {
    errors.push('request-review still forces every local verdict onto GitHub.');
  }
  for (const [label, source] of [
    ['cross-cat-handoff convention', handoffSkill],
    ['request-review convention', requestReviewSkill],
    ['receive-review convention', receiveReviewSkill],
    ['merge-gate convention', mergeGateSkill],
  ]) {
    const retiredControls = [
      'coordination.phase=' + 'terminal',
      'review' + 'Reentry',
      'record_local_review_' + 'verdict',
      'recover_local_review_' + 'verdict',
    ];
    for (const retired of retiredControls) {
      if (source.includes(retired)) errors.push(`${label} still mentions retired local review control ${retired}.`);
    }
  }
  return errors;
}
