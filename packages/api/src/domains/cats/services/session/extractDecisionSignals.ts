/**
 * extractDecisionSignals — F148 VG-3
 * Pure function: extracts decision/question/artifact signals from transcript text + ThreadSummary.
 * Zero LLM cost — regex patterns reuse AutoSummarizer's proven set.
 */

import type { ThreadMemorySourceRef } from '../stores/ports/ThreadStore.js';

const MAX_DECISIONS = 8;
const MAX_OPEN_QUESTIONS = 5;
const MAX_ARTIFACTS = 8;
const MAX_SENTENCE_LEN = 100;

const DECISION_PATTERNS = [/决定|确定|选择|采用|使用|拍板|定了|实现了|完成了|修复了|同意/];
const QUESTION_PATTERNS = [/需要|待定|TODO|还没|未来|后续|是否|待确认|待实验|阈值/];
const ARTIFACT_PATTERN = /\b(ADR-\d+|F\d{2,3})\b/g;

export interface DecisionSignals {
  decisions: string[];
  decisionRefs?: Array<ThreadMemorySourceRef | null>;
  openQuestions: string[];
  openQuestionRefs?: Array<ThreadMemorySourceRef | null>;
  artifacts: string[];
}

export interface DecisionSignalsInput {
  transcriptText: string;
  transcriptEntries?: Array<{ content: string; sourceRef: ThreadMemorySourceRef }>;
  summaryConclusions: string[];
  summaryOpenQuestions: string[];
}

/** Check if a is a substring of b or b is a substring of a */
function overlaps(a: string, b: string): boolean {
  const short = a.length <= b.length ? a : b;
  const long = a.length <= b.length ? b : a;
  return long.includes(short);
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

interface ReferencedSignal {
  text: string;
  sourceRef: ThreadMemorySourceRef | null;
}

function dedupReferenced(items: ReferencedSignal[], max: number): ReferencedSignal[] {
  const result: ReferencedSignal[] = [];
  for (const item of items) {
    if (!result.some((existing) => overlaps(existing.text, item.text))) result.push(item);
    if (result.length >= max) break;
  }
  return result;
}

function extractReferenced(input: DecisionSignalsInput, patterns: RegExp[], max: number): ReferencedSignal[] {
  if (!input.transcriptEntries?.length) {
    return extractFromText(input.transcriptText, patterns, max).map((text) => ({ text, sourceRef: null }));
  }
  const extracted: ReferencedSignal[] = [];
  for (const entry of input.transcriptEntries) {
    for (const text of extractFromText(entry.content, patterns, max)) {
      extracted.push({ text, sourceRef: entry.sourceRef });
      if (extracted.length >= max) return extracted;
    }
  }
  return extracted;
}

export function extractDecisionSignals(input: DecisionSignalsInput): DecisionSignals {
  // 1. Regex extraction from transcript
  const regexDecisions = extractReferenced(input, DECISION_PATTERNS, MAX_DECISIONS);
  const regexQuestions = extractReferenced(input, QUESTION_PATTERNS, MAX_OPEN_QUESTIONS);

  // 2. Artifact references from transcript
  const artifactMatches = new Set<string>();
  for (const match of input.transcriptText.matchAll(ARTIFACT_PATTERN)) {
    artifactMatches.add(match[1]);
  }

  // 3. Combine with ThreadSummary (summary first — higher quality)
  const allDecisions = [...input.summaryConclusions.map((text) => ({ text, sourceRef: null })), ...regexDecisions];
  const allQuestions = [...input.summaryOpenQuestions.map((text) => ({ text, sourceRef: null })), ...regexQuestions];

  const decisions = dedupReferenced(allDecisions, MAX_DECISIONS);
  const questions = dedupReferenced(allQuestions, MAX_OPEN_QUESTIONS);

  // 4. Dedup + cap
  return {
    decisions: decisions.map((item) => item.text),
    decisionRefs: decisions.map((item) => item.sourceRef),
    openQuestions: questions.map((item) => item.text),
    openQuestionRefs: questions.map((item) => item.sourceRef),
    artifacts: [...artifactMatches].slice(0, MAX_ARTIFACTS),
  };
}
