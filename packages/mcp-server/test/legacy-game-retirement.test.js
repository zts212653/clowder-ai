import assert from 'node:assert/strict';
import { it } from 'node:test';
import { CORE_COMMANDS } from '@cat-cafe/shared';
import { CANONICAL_TOOL_REGISTRY } from '../dist/canonical-server-tools.js';

it('does not advertise the retired game command', () => {
  assert.equal(
    CORE_COMMANDS.some((command) => command.name === '/game'),
    false,
  );
});
it('does not advertise the retired game action tool', () => {
  assert.equal(
    CANONICAL_TOOL_REGISTRY.some((tool) => tool.name === 'cat_cafe_submit_game_action'), // mcp-cutover-negative-reference: absence
    false,
  );
});
