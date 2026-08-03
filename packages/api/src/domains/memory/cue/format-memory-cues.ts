import type { CueEnvelopeV1 } from '@cat-cafe/shared';
import { estimateTokens } from '../../../utils/token-counter.js';

export interface FormattedMemoryCues {
  cues: CueEnvelopeV1[];
  text: string;
  estimatedTokens: number;
}

function renderCue(cue: CueEnvelopeV1): string {
  return [
    `<memory-cue v="1" cue-id="${cue.cueId}" why-now="${cue.whyNow}">`,
    `Title: ${cue.title}`,
    `Summary: ${cue.summary}`,
    `Source: ${cue.source.anchor} @ ${cue.source.revision}`,
    `Drill: ${cue.drill.family} ${cue.drill.handle}`,
    '</memory-cue>',
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
    const nextBlocks = [...blocks, renderCue(cue)];
    const nextText = nextBlocks.join('\n\n');
    const nextTokens = estimateTokens(nextText);
    if (nextTokens > options.maxTokens) continue;
    cues.push(cue);
    blocks.push(nextBlocks[nextBlocks.length - 1]);
    estimatedTokens = nextTokens;
  }
  return { cues, text: blocks.join('\n\n'), estimatedTokens };
}
