import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { it } from 'node:test';
import { ROOT } from './context.mjs';

export function registerPublicDocsPart1() {
  it('workspace-navigator uses typed MCP instead of raw API port guidance', () => {
    const content = readFileSync(resolve(ROOT, 'cat-cafe-skills/workspace-navigator/SKILL.md'), 'utf-8');
    assert.doesNotMatch(
      content,
      /API_SERVER_PORT=3004|API_SERVER_PORT:-3004/,
      'workspace-navigator should not hardcode the home-only API default in public-facing usage guidance',
    );
    assert.doesNotMatch(
      content,
      /API_PORT=/,
      'workspace-navigator should not require cats to hand-manage first-party API ports',
    );
    assert.doesNotMatch(
      content,
      /curl\s+-X\s+POST[\s\S]{0,200}\/api\/workspace\/navigate/,
      'workspace-navigator should not use raw curl as the first-party Hub action main path',
    );
    assert.match(
      content,
      /cat_cafe_workspace_navigate\(\{/,
      'workspace-navigator should teach the typed MCP main path',
    );
  });
}
