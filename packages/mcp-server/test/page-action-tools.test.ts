import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCollabTools } from '../src/server-toolsets.js';

test('Live exposes only page inspection and status, without grant, URL, selector or source input', () => {
  const tools = buildCollabTools({ desktopMode: 'live-companion', readonly: false, hasAgentKey: false });
  const page = tools.filter((tool) => tool.name.startsWith('cat_cafe_page_action_'));
  assert.deepEqual(page.map((tool) => tool.name).sort(), [
    'cat_cafe_page_action_inspect',
    'cat_cafe_page_action_status',
  ]);
  for (const tool of page) assert.deepEqual(Object.keys(tool.inputSchema), []);
  assert.equal(page.find((tool) => tool.name === 'cat_cafe_page_action_inspect')?.annotations?.openWorldHint, true);
  for (const env of [
    { readonly: true, hasAgentKey: false },
    { readonly: true, hasAgentKey: true, agentKeyUnion: true },
    { desktopMode: 'fable-phase0', readonly: false, hasAgentKey: false },
  ])
    assert.equal(
      buildCollabTools(env).some((tool) => tool.name.startsWith('cat_cafe_page_action_')),
      false,
    );
});
