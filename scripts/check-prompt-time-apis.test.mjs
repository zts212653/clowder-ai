import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { checkPromptTimeApisForRepo } from './check-prompt-time-apis.mjs';

function makeRepo() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'prompt-time-apis-test-'));
  mkdirSync(path.join(root, 'packages/api/src/domains/cats/services/context'), { recursive: true });
  mkdirSync(path.join(root, 'packages/api/src/domains/cats/services/agents/routing'), { recursive: true });
  mkdirSync(path.join(root, 'packages/api/src/domains/cats/services/stores'), { recursive: true });
  return root;
}

describe('F257 prompt time API guard', () => {
  it('fails on naked HH:mm extraction in prompt-facing code', () => {
    const root = makeRepo();
    try {
      writeFileSync(
        path.join(root, 'packages/api/src/domains/cats/services/context/bad.ts'),
        'const hhmm = new Date(ts).toISOString().slice(11, 16);\n',
      );

      const result = checkPromptTimeApisForRepo(root);
      assert.equal(result.ok, false);
      assert.match(result.violations[0].api, /toISOString/);
      assert.equal(result.violations[0].path, 'packages/api/src/domains/cats/services/context/bad.ts');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('passes when prompt-facing code uses the formatter', () => {
    const root = makeRepo();
    try {
      writeFileSync(
        path.join(root, 'packages/api/src/domains/cats/services/agents/routing/good.ts'),
        'const label = formatPromptTime(ts, { timeZone });\n',
      );

      const result = checkPromptTimeApisForRepo(root);
      assert.equal(result.ok, true, result.violations.map((hit) => hit.path).join('\n'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not scan non-prompt implementation paths', () => {
    const root = makeRepo();
    try {
      writeFileSync(
        path.join(root, 'packages/api/src/domains/cats/services/stores/internal.ts'),
        'const hour = new Date(ts).getHours();\n',
      );

      const result = checkPromptTimeApisForRepo(root);
      assert.equal(result.ok, true, result.violations.map((hit) => hit.path).join('\n'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
