import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { findReplayUnsafeToolNames } = await import('../dist/domains/cats/services/freshness/tool-replay-safety.js');

describe('F254 replay safety classifier', () => {
  it('allows only reviewed read-only tools and fails closed for hold/edit/shell/unknown tools', () => {
    assert.deepEqual(
      findReplayUnsafeToolNames([
        'Read',
        'Grep',
        'Skill',
        'mcp__cat-cafe-memory__cat_cafe_search_evidence',
        'mcp:cat-cafe-memory/search_evidence',
        'mcp__cat-cafe-collab__cat_cafe_hold_ball',
        'Edit',
        'Bash',
        'future_tool_we_do_not_know',
        'Edit',
      ]),
      ['Bash', 'Edit', 'future_tool_we_do_not_know', 'mcp__cat-cafe-collab__cat_cafe_hold_ball'],
    );
  });
});
