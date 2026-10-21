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
