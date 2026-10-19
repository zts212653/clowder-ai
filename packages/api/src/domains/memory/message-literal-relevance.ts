import { splitLexicalBackfillWords } from './lexical-backfill.js';
import { literalTermCoverage } from './literal-term-coverage.js';
import type { PassageResult } from './SqliteEvidenceStore.js';

type LiteralPassage = Pick<PassageResult, 'content'>;
type Score = { coverage: number; specificity: number };

// Match SQLite LOWER, which folds ASCII rather than locale-dependent Unicode.
const fold = (value: string): string => value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());

/** Query-derived literal evidence, shared by pre-LIMIT SQL and hybrid ordering. */
export function messageLiteralRelevance(query: string) {
  const words = [...new Set(query.trim().split(/\s+/).filter(Boolean).map(fold))];
  if (!words.some((word) => /[一-鿿㐀-䶿]/.test(word))) return undefined;
  const coverage = literalTermCoverage(words);
  const chinese = literalTermCoverage(splitLexicalBackfillWords(query).filter((word) => /[一-鿿㐀-䶿]/.test(word)));
  const phrase = fold(query.trim());
  const scores = new WeakMap<LiteralPassage, Score>();
  const score = (passage: LiteralPassage): Score => {
    const cached = scores.get(passage);
    if (cached) return cached;
    const content = fold(passage.content);
    let length = 0;
    // SQLite length(TEXT) counts code points and stops at the first NUL.
    for (const point of content) {
      if (point === '\0') break;
      length++;
    }
    const result = {
      coverage: coverage(content),
      // Count a phrase once: repeating the question cannot manufacture evidence.
      specificity: content.includes(phrase) ? 1 / Math.max(1, length) : 0,
    };
    scores.set(passage, result);
    return result;
  };

  return {
    selectSql: `message_literal_coverage(LOWER(p.content)) AS literalCoverage,
      CASE WHEN instr(LOWER(p.content), ?) > 0 THEN 1.0 / MAX(1, length(p.content)) ELSE 0 END AS literalSpecificity`,
    params: [phrase],
    // SQL LOWER does the same ASCII fold once in native code per callback.
    coverageFolded: coverage,
    matchesChineseFolded(content: string): number {
      return Number(chinese(content) > 0);
    },
    compareLexical(a: PassageResult, b: PassageResult): number {
      const left = score(a);
      const right = score(b);
      return right.coverage - left.coverage || right.specificity - left.specificity;
    },
    compareExact(a: PassageResult, b: PassageResult): number {
      return score(b).specificity - score(a).specificity;
    },
  };
}
