import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

test('passage embedding warm-up is paginated and single-flight', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/domains/memory/IndexBuilder.ts'), 'utf8');
  const start = source.indexOf('private async embedMissingPassages');
  const end = source.indexOf('/**\n   * E-3:', start);
  assert.ok(start > 0 && end > start, 'embedMissingPassages method should be present');
  const method = source.slice(start, end);

  assert.match(source, /passageEmbeddingWarmupInFlight/);
  assert.match(method, /LIMIT \?/);
  assert.doesNotMatch(method, /SELECT passage_key AS passageKey FROM passage_vectors'[\s\S]*\.all\(\)/);
  assert.doesNotMatch(
    method,
    /SELECT doc_anchor AS docAnchor, passage_id AS passageId, content FROM evidence_passages'[\s\S]*\.all\(\.\.\.params\)/,
  );
});
