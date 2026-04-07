/**
 * extractDecisionSignals — F148 VG-3
 * Pure function: extracts decision/question/artifact signals from transcript text + ThreadSummary.
 * Zero LLM cost — regex patterns reuse AutoSummarizer's proven set.
 */

const MAX_DECISIONS = 8;
const MAX_OPEN_QUESTIONS = 5;
const MAX_ARTIFACTS = 8;
const MAX_SENTENCE_LEN = 100;

const DECISION_PATTERNS = [/决定|确定|选择|采用|使用|拍板|定了|实现了|完成了|修复了|同意/];
const QUESTION_PATTERNS = [/需要|待定|TODO|还没|未来|后续|是否|待确认|待实验|阈值/];
const ARTIFACT_PATTERN = /\b(ADR-\d+|F\d{2,3})\b/g;

export interface DecisionSignals {
  decisions: string[];
  openQuestions: string[];
  artifacts: string[];
}

export interface DecisionSignalsInput {
  transcriptText: string;
  summaryConclusions: string[];
  summaryOpenQuestions: string[];
}

/** Check if a is a substring of b or b is a substring of a */
function overlaps(a: string, b: string): boolean {
  const short = a.length <= b.length ? a : b;
  const long = a.length <= b.length ? b : a;
  return long.includes(short);
}

function dedup(items: string[]): string[] {
  const result: string[] = [];
  for (const item of items) {
    if (!result.some((existing) => overlaps(existing, item))) {
      result.push(item);
    }
  }
  return result;
}

function extractFromText(text: string, patterns: RegExp[], max: number): string[] {
  if (!text) return [];
  const sentences = text.split(/[。！？\n]/).filter((s) => s.trim().length > 5);
  const matches: string[] = [];
  for (const s of sentences) {
    const trimmed = s.trim().slice(0, MAX_SENTENCE_LEN);
    if (patterns.some((p) => p.test(trimmed)) && matches.length < max) {
      matches.push(trimmed);
    }
  }
  return matches;
}

export function extractDecisionSignals(input: DecisionSignalsInput): DecisionSignals {
  // 1. Regex extraction from transcript
  const regexDecisions = extractFromText(input.transcriptText, DECISION_PATTERNS, MAX_DECISIONS);
  const regexQuestions = extractFromText(input.transcriptText, QUESTION_PATTERNS, MAX_OPEN_QUESTIONS);

  // 2. Artifact references from transcript
  const artifactMatches = new Set<string>();
  for (const match of input.transcriptText.matchAll(ARTIFACT_PATTERN)) {
    artifactMatches.add(match[1]);
  }

  // 3. Combine with ThreadSummary (summary first — higher quality)
  const allDecisions = [...input.summaryConclusions, ...regexDecisions];
  const allQuestions = [...input.summaryOpenQuestions, ...regexQuestions];

  // 4. Dedup + cap
  return {
    decisions: dedup(allDecisions).slice(0, MAX_DECISIONS),
    openQuestions: dedup(allQuestions).slice(0, MAX_OPEN_QUESTIONS),
    artifacts: [...artifactMatches].slice(0, MAX_ARTIFACTS),
  };
}
