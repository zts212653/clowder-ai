import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(apiRoot, '../..');

function source(path) {
  return readFileSync(resolve(repoRoot, path), 'utf8');
}

describe('F167 durable local review handoff guard', () => {
  it('requires an exact typed review fact without action-lease route fencing', () => {
    assert.match(source('packages/api/src/routes/callbacks.ts'), /localReviewVerdict/);
    assert.match(source('packages/api/src/routes/callbacks.ts'), /invalid_review_fact/);
    assert.doesNotMatch(source('packages/api/src/routes/callbacks.ts'), /preflightLocalReviewTerminalRoute/);
    assert.match(source('packages/mcp-server/src/tools/callback-tools.ts'), /needs no action lease/);
  });

  it('teaches every local-review convention to use ordinary durable review facts', () => {
    for (const path of [
      'cat-cafe-skills/cross-cat-handoff/SKILL.md',
      'cat-cafe-skills/request-review/SKILL.md',
      'cat-cafe-skills/receive-review/SKILL.md',
    ]) {
      assert.match(source(path), /localReviewVerdict/i, path);
    }
  });
});
