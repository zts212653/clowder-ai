import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';

const root = resolve(import.meta.dirname, '../../..');

describe('Thread progress prompt adoption', () => {
  test('L5 and L6 expose the tool and high-precision abstention rule', () => {
    const l5 = readFileSync(resolve(root, 'assets/prompt-templates/l5-mcp-tools-index.md'), 'utf8');
    const l6 = readFileSync(resolve(root, 'assets/prompt-templates/l6-capability-wakeup.md'), 'utf8');
    assert.match(l5, /cat_cafe_record_thread_progress/);
    assert.match(l6, /关键变化/);
    assert.match(l6, /无需写回|abstain/i);
    assert.match(l6, /final 前/);
  });
});
