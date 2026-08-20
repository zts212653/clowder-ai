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

describe('F167 direct review carrier affinity guard', () => {
  it('keeps machine-readable subject and terminal-route fences on the callback carrier', () => {
    assert.match(source('packages/shared/src/types/cross-thread-coordination.ts'), /subjectRef\?: string/);
    assert.match(source('packages/api/src/routes/callbacks.ts'), /preflightLocalReviewTerminalRoute/);
    assert.match(source('packages/mcp-server/src/tools/callback-tools.ts'), /subjectRef: z/);
  });

  it('teaches every local-review convention that the direct review carrier outranks task ancestry', () => {
    for (const path of [
      'cat-cafe-skills/cross-cat-handoff/SKILL.md',
      'cat-cafe-skills/request-review/SKILL.md',
      'cat-cafe-skills/receive-review/SKILL.md',
    ]) {
      assert.match(source(path), /direct review carrier/i, path);
    }
    assert.match(source('packages/api/src/domains/prompt-hooks/resolvers/turn-resolvers-a.ts'), /new workflow action/i);
  });
});
