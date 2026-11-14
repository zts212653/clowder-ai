import { splitLexicalBackfillWords } from './lexical-backfill.js';
import { literalTermCoverage } from './literal-term-coverage.js';
import type { PassageResult } from './SqliteEvidenceStore.js';

type LiteralPassage = Pick<PassageResult, 'content'>;
type Score = { coverage: number; specificity: number };

// Match SQLite LOWER, which folds ASCII rather than locale-dependent Unicode.
const fold = (value: string): string => value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());

function chineseNecessarySubstring(word: string): string {
  let longest = '';
  for (const [run] of word.matchAll(/[一-鿿㐀-䶿]+/g)) {
    if (run.length > longest.length) longest = run;
  }
  return longest.slice(0, 8);
}

function chineseLiteralMatch(words: string[]): (content: string) => number {
  // Preserve the existing small-query native substring path, with early exit.
  if (words.length <= 4) return (content) => Number(words.some((word) => content.includes(word)));
  // Long near-matching prefixes can make native alternation slower than the
  // linear automaton. Bound literal width on the accelerated path; 32 is an
  // algorithm selection limit, never a query/term truncation.
  if (words.some((word) => word.length > 32)) {
    const coverage = literalTermCoverage(words);
    return (content) => Number(coverage(content) > 0);
  }
  // Admission needs any hit. Escaped, flagless alternatives preserve UTF-16
  // includes semantics; distinct-term counting stays on the ranking path.
  const literal = new RegExp(words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'));
  return (content) => Number(literal.test(content));
}

/** Query-derived literal evidence, shared by pre-LIMIT SQL and hybrid ordering. */
export function messageLiteralRelevance(query: string) {
  const words = [...new Set(query.trim().split(/\s+/).filter(Boolean).map(fold))];
  if (!words.some((word) => /[一-鿿㐀-䶿]/.test(word))) return undefined;
  const coverage = literalTermCoverage(words);
  const chineseWords = splitLexicalBackfillWords(query).filter((word) => /[一-鿿㐀-䶿]/.test(word));
  const chinese = chineseLiteralMatch(chineseWords);
  // A full term hit must contain every unchanged Han run in that term. This
  // bounded necessary condition can reject bodies in SQLite before copying
  // them to JavaScript. The complete terms still decide membership below.
  // Bound needle width too: long shared prefixes must not turn native instr
  // into an unbounded per-character comparison. Neither bound truncates terms.
  const chinesePrefilter = chineseWords.length <= 4 ? [...new Set(chineseWords.map(chineseNecessarySubstring))] : [];
  const phrase = fold(query.trim());
  // Spaces between CJK terms are query separators, not stronger evidence in
  // quoted query/diagnostic messages than the same adjacent words in an original.
  // Retain the exact spelling too; do not remove Latin word boundaries.
  const phrases = [...new Set([phrase, phrase.replace(/([一-鿿㐀-䶿])\s+(?=[一-鿿㐀-䶿])/g, '$1')])];
  const scores = new WeakMap<LiteralPassage, Score>();
  const score = (passage: LiteralPassage): Score => {
    const cached = scores.get(passage);
    if (cached) return cached;
    const content = fold(passage.content);
    let specificity = 0;
    if (phrases.some((value) => content.includes(value))) {
      let length = 0;
      // SQLite length(TEXT) counts code points and stops at the first NUL.
      for (const point of content) {
        if (point === '\0') break;
        length++;
      }
      // Count a phrase once: repeating the question cannot manufacture evidence.
      specificity = 1 / Math.max(1, length);
    }
    const result = {
      coverage: coverage(content),
      specificity,
    };
    scores.set(passage, result);
    return result;
  };

  return {
    selectSql: `message_literal_coverage(LOWER(p.content)) AS literalCoverage,
      CASE WHEN ${phrases.map(() => 'instr(LOWER(p.content), ?) > 0').join(' OR ')} THEN 1.0 / MAX(1, length(p.content)) ELSE 0 END AS literalSpecificity`,
    params: phrases,
    chinesePrefilter,
    // SQL LOWER does the same ASCII fold once in native code per callback.
    coverageFolded: coverage,
    matchesChineseFolded(content: string): number {
      return chinese(content);
    },
    compareLexical(a: PassageResult, b: PassageResult): number {
      const left = score(a);
      const right = score(b);
      return right.coverage - left.coverage || right.specificity - left.specificity;
    },
    compareHybrid(a: PassageResult, b: PassageResult): number {
      const left = score(a);
      const right = score(b);
      // Natural query words need not be adjacent or in query order. Complete
      // literal evidence survives fusion; partial/semantic rows still use RRF.
      return (
        Number(right.coverage === words.length) - Number(left.coverage === words.length) ||
        right.specificity - left.specificity
      );
    },
  };
}
