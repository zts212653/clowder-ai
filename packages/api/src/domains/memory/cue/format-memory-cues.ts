import type { CueEnvelopeV1 } from '@cat-cafe/shared';
import { estimateTokens } from '../../../utils/token-counter.js';

export interface FormattedMemoryCues {
  cues: CueEnvelopeV1[];
  text: string;
  estimatedTokens: number;
}

function explicitTasteAction(cue: CueEnvelopeV1): string[] {
  return cue.resolverFamily === 'taste' && cue.source.anchor.startsWith('taste-vignette:')
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

export function renderMemoryCue(cue: CueEnvelopeV1): string {
  return [
    `<memory-cue v="1" cue-id="${cue.cueId}" why-now="${cue.whyNow}">`,
    `Title: ${cue.title}`,
    `Summary: ${cue.summary}`,
    `Source: ${cue.source.anchor} @ ${cue.source.revision}${
      cue.source.asOf === undefined ? '' : ` asOf=${new Date(cue.source.asOf).toISOString()}`
    }`,
    `Drill: ${cue.drill.family} ${cue.drill.handle}`,
    ...explicitTasteAction(cue),
    ...profileAction(cue),
    ...eventAction(cue),
    '</memory-cue>',
  ].join('\n');
}

/** F296 T2 rendering: an exact retrieval entry, never candidate title/summary/body. */
export function renderMemoryCuePointer(cue: CueEnvelopeV1): string {
  return [
    `<recall-opportunity-pointer v="1" opportunity-id="${cue.opportunityId}">`,
    `Drill: ${cue.drill.family} ${cue.drill.handle}`,
    ...explicitTasteAction(cue),
    ...profileAction(cue),
    ...eventAction(cue),
    '</recall-opportunity-pointer>',
  ].join('\n');
}

export function formatMemoryCues(
  candidates: readonly CueEnvelopeV1[],
  options: { maxTokens: number },
): FormattedMemoryCues {
  if (!Number.isInteger(options.maxTokens) || options.maxTokens <= 0) {
    return { cues: [], text: '', estimatedTokens: 0 };
  }
  const cues: CueEnvelopeV1[] = [];
  const blocks: string[] = [];
  let estimatedTokens = 0;
  for (const cue of candidates) {
    const nextBlocks = [...blocks, renderMemoryCue(cue)];
    const nextText = nextBlocks.join('\n\n');
    const nextTokens = estimateTokens(nextText);
    if (nextTokens > options.maxTokens) continue;
    cues.push(cue);
    blocks.push(nextBlocks[nextBlocks.length - 1]);
    estimatedTokens = nextTokens;
  }
  return { cues, text: blocks.join('\n\n'), estimatedTokens };
}
