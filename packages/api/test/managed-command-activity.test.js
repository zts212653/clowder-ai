import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { classifyManagedCommandActivity } = await import(
  '../dist/domains/cats/services/agents/invocation/managed-command-activity.js'
);

describe('managed command activity classification', () => {
  const cases = [
    ["bash -lc 'pnpm gate'", 'full_gate'],
    ['bash scripts/pre-merge-check.sh', 'full_gate'],
    ['AWS_SECRET_ACCESS_KEY=abc123 pnpm gate', 'full_gate'],
    ['env -u NODE_ENV pnpm build', 'build'],
    ['pnpm --filter @cat-cafe/api test:redis', 'test'],
    ['node --test x.test.js', 'test'],
    ['pnpm build && pnpm test', 'test'],
    ['echo "pnpm gate"', 'command'],
    ['echo pnpm gate', 'command'],
    ['curl -H "Authorization: Bearer SUPERSECRET" https://example.invalid', 'command'],
  ];

  for (const [command, expected] of cases) {
    it(`classifies the executable shape as ${expected}`, () => {
      assert.equal(classifyManagedCommandActivity(command), expected);
    });
  }
});
