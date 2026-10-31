import type { CueEnvelopeV1 } from '@cat-cafe/shared';
import { estimateTokens } from '../../../utils/token-counter.js';
import { EXPLICIT_APPROVED_TASTE_SOURCE_ANCHOR_PREFIX } from './ExplicitApprovedTasteTriggerCatalog.js';
import { TASTE_TASK_BUNDLE_SOURCE_ANCHOR_PREFIX } from './TasteTaskBundleCatalog.js';

export interface FormattedMemoryCues {
  cues: CueEnvelopeV1[];
  text: string;
  estimatedTokens: number;
}

function explicitTasteAction(cue: CueEnvelopeV1): string[] {
  if (cue.resolverFamily !== 'taste') return [];
  if (cue.source.anchor.startsWith(TASTE_TASK_BUNDLE_SOURCE_ANCHOR_PREFIX)) {
    return [
      'Action: Drill this exact approved source; record applied/dismissed, or preserve an explicit unconfirmed row in task evidence.',
    ];
  }
  return cue.source.anchor.startsWith(EXPLICIT_APPROVED_TASTE_SOURCE_ANCHOR_PREFIX)
    ? ['Action: Drill before responding; record applied only after satisfying the typed application contract.']
    : [];
}

function profileAction(cue: CueEnvelopeV1): string[] {
  return cue.resolverFamily === 'profile'
    ? [
        'Action: Drill before responding; record applied only if the approved Profile revision changes this response, otherwise dismissed.',
      ]
    : [];
}

function eventAction(cue: CueEnvelopeV1): string[] {
  return cue.resolverFamily === 'event'
    ? [
        'Action: Drill before responding; record applied only if this Event establishes chronology or continuity used in the response, otherwise dismissed.',
      ]
    : [];
}

function operationalKnowledgeAction(cue: CueEnvelopeV1): string[] {
  if (cue.resolverFamily === 'decision') {
    return [
      'Action: Drill before responding; record applied only if this accepted decision constrains the current response or action, otherwise dismissed.',
    ];
  }
  if (cue.resolverFamily === 'project_knowledge') {
    return [
      'Action: Drill before responding; record applied only if this project source grounds the current task response, otherwise dismissed.',
    ];
  }
  return [];
}

function catOwnedSeedAction(cue: CueEnvelopeV1): string[] {
  return cue.resolverFamily === 'cat_owned_seed'
    ? [
        'Action: Drill only in this private Present Loop; record applied only after creating a same-invocation intent for this seed, otherwise dismissed.',
      ]
    : [];
}

function threadOverviewAction(cue: CueEnvelopeV1): string[] {
  if (cue.resolverFamily !== 'thread_overview') return [];
  return [
    `Historical thread clue (T2): ${cue.title}`,
    `Why related: ${cue.whyNow}`,
    `Useful background with original sources: ${cue.summary}`,
    'Action: Drill the full current overview and original messages before relying on it. Verify current agreements in canonical sources; verify work progress against current Task/PR. Record applied only when this background changes your response, otherwise dismissed.',
  ];
}

function drillInstructions(cue: CueEnvelopeV1): string[] {
  return [
    `Family: ${cue.drill.family}`,
    `Handle: ${cue.drill.handle}`,
    'Drill: cat_cafe_drill_memory_cue(handle=Handle); then cat_cafe_record_memory_cue_outcome(handle=Handle, outcome=applied|dismissed). Use the exact Handle value for both.',
  ];
}

export function renderMemoryCue(cue: CueEnvelopeV1): string {
  return [
    `<memory-cue v="1" cue-id="${cue.cueId}" why-now="${cue.whyNow}">`,
    `Title: ${cue.title}`,
    `Summary: ${cue.summary}`,
    `Source: ${cue.source.anchor} @ ${cue.source.revision}${
      cue.source.asOf === undefined ? '' : ` asOf=${new Date(cue.source.asOf).toISOString()}`
    }`,
    ...drillInstructions(cue),
    ...explicitTasteAction(cue),
    ...profileAction(cue),
    ...eventAction(cue),
    ...operationalKnowledgeAction(cue),
    ...catOwnedSeedAction(cue),

    '</memory-cue>',
  ].join('\n');
}

/** F296 generic T2 pointer remains content-free. F321 clues use their distinct admitted rendering. */
export function renderMemoryCuePointer(cue: CueEnvelopeV1): string {
  return [
    `<recall-opportunity-pointer v="1" opportunity-id="${cue.opportunityId}">`,
    ...drillInstructions(cue),
    ...explicitTasteAction(cue),
    ...profileAction(cue),
    ...eventAction(cue),
    ...operationalKnowledgeAction(cue),
    ...catOwnedSeedAction(cue),

    '</recall-opportunity-pointer>',
  ].join('\n');
}

export function formatMemoryCues(
  candidates: readonly CueEnvelopeV1[],
  options: { maxTokens: number; pointerOnly?: boolean },
): FormattedMemoryCues {
  if (!Number.isInteger(options.maxTokens) || options.maxTokens <= 0) {
    return { cues: [], text: '', estimatedTokens: 0 };
  }
  const cues: CueEnvelopeV1[] = [];
  const blocks: string[] = [];
  let estimatedTokens = 0;
  for (const cue of candidates) {
    const nextBlocks = [...blocks, options.pointerOnly ? renderMemoryCuePointer(cue) : renderMemoryCue(cue)];
    const nextText = nextBlocks.join('\n\n');
    const nextTokens = estimateTokens(nextText);
    if (nextTokens > options.maxTokens) continue;
    cues.push(cue);
    blocks.push(nextBlocks[nextBlocks.length - 1]);
    estimatedTokens = nextTokens;
  }
  return { cues, text: blocks.join('\n\n'), estimatedTokens };
}

export function renderThreadOpeningClue(cue: CueEnvelopeV1): string {
  return [
    `<thread-opening-clue v="1" source-tier="T2" cue-id="${cue.cueId}" opportunity-id="${cue.opportunityId}">`,
    ...threadOverviewAction(cue),
    ...drillInstructions(cue),
    '</thread-opening-clue>',
  ].join('\n');
}
