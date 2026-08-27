import { estimateTokens } from '../../utils/token-counter.js';
import { MeetingArtifactResourceError } from './meeting-artifact-resource-contract.js';

interface TextPage {
  readonly content: string;
  readonly nextOffset: number;
  readonly hasMore: boolean;
}

/** Select the largest checked character page that also fits the canonical token estimate. */
export function pageWithinMeetingArtifactBudgets(
  makePage: (characterBudget: number) => TextPage,
  maxChars: number,
  maxTokens: number,
): TextPage & { readonly estimatedTokens: number } {
  let low = 1;
  let high = maxChars;
  let best: (TextPage & { readonly estimatedTokens: number }) | null = null;
  while (low <= high) {
    const characterBudget = Math.floor((low + high) / 2);
    const page = makePage(characterBudget);
    const estimatedTokens = estimateTokens(page.content);
    if (estimatedTokens <= maxTokens) {
      best = { ...page, estimatedTokens };
      low = characterBudget + 1;
    } else {
      high = characterBudget - 1;
    }
  }
  if (best) return best;
  const smallest = makePage(1);
  if (!smallest.content) return { ...smallest, estimatedTokens: 0 };
  throw new MeetingArtifactResourceError(
    'INVALID_READ_REQUEST',
    'maxTokens is too small for the next source unit; increase the explicit token bound',
  );
}
