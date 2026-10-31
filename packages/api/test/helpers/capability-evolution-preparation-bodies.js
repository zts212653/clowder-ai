export function objectBody(label = 'Candidate stack') {
  return {
    kind: 'object_map',
    goalStatement: '让 PM Agent 专业推进项目，只在必要时请人介入',
    summary: 'Multiple candidates remain open.',
    items: [
      {
        itemId: 'stack',
        label,
        scope: 'PM capability stack.',
        why: 'Several layers can explain the outcome.',
        modifiability: { state: 'unknown', reason: 'Owner check pending.', basisRefs: [] },
        sourceRefs: [],
        nextAction: 'Resolve owners.',
      },
    ],
    unknowns: ['No baseline.'],
    nextAction: 'Inspect versions.',
  };
}

export function humanChoiceBody(input, threadId) {
  const body = objectBody();
  body.items[0].category = 'Harness';
  body.items[0].modifiability = {
    state: 'modifiable',
    reason: '当前授权内',
    basisRefs: [{ ownerFeatureId: 'F117', ownerStateRef: `message:${input.id}` }],
  };
  body.items[0].recommendation = {
    summary: '先比较',
    reason: '路由有可重放失败',
    basisRefs: body.items[0].modifiability.basisRefs,
  };
  body.items[0].decision = {
    state: 'explore',
    reason: '按真实人类输入修订',
    basisRefs: body.items[0].modifiability.basisRefs,
    responsibility: { kind: 'human', input: { threadId, messageId: input.id } },
  };
  return body;
}

export function successBody() {
  return {
    kind: 'success_contract',
    summary: 'Judge necessary escalation separately.',
    criteria: [
      {
        criterionId: 'necessary-escalation',
        label: 'Necessary escalation',
        utilityClaim: 'Escalate only when owner judgment is needed.',
        observationUnit: 'One opportunity.',
        estimator: 'Independently judged necessary escalations over all necessary opportunities.',
        counterexample: 'Sampling requests misses silent failures.',
        gtDomain: 'semi_verifiable',
        judge: 'calibrated_judge',
        payer: { kind: 'human_attention', detail: 'A domain owner calibrates boundary cases.' },
        gtSourceKeys: ['domain-boundaries'],
        validityBounds: ['Reviewed project class only.'],
        unknowns: ['Judge not named.'],
        nextAction: 'Calibrate examples.',
      },
    ],
    unknowns: ['No threshold.'],
    nextAction: 'Connect GT.',
  };
}
