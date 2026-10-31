/**
 * F221 Phase B: Taste signal routing guard.
 *
 * Detects taste-signal keywords in propose_profile_update content and returns
 * a routing advisory suggesting cat_cafe_propose_taste instead.
 *
 * This is an ADVISORY — it does NOT block proposal creation.
 * Per KD-8: we give data (advisory), not conclusions (blocking).
 */

export interface TasteRoutingAdvisory {
  suggestedTool: 'cat_cafe_propose_taste';
  reason: string;
}

const TASTE_KEYWORDS_ZH = [
  '品味',
  '审美',
  '太客服',
  '不美',
  '活人感',
  '脚手架',
  '第一性原理',
  '数学之美',
  '这就是我要的',
];
const TASTE_KEYWORDS_EN = ['aha', 'ai slop'];

export function detectTasteSignal(input: { rationale?: string; afterContent?: string }): TasteRoutingAdvisory | null {
  const corpus = `${input.rationale ?? ''} ${input.afterContent ?? ''}`.toLowerCase();
  if (corpus.trim().length === 0) return null;

  const matchZh = TASTE_KEYWORDS_ZH.find((kw) => corpus.includes(kw));
  const matchEn = TASTE_KEYWORDS_EN.find((kw) => corpus.includes(kw));
  const match = matchZh ?? matchEn;

  if (!match) return null;

  return {
    suggestedTool: 'cat_cafe_propose_taste',
    reason: `Content contains taste signal keyword "${match}". Consider using cat_cafe_propose_taste to capture this as a taste vignette instead of a profile update.`,
  };
}
