import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildAudioTools,
  buildCollabTools,
  buildFinanceTools,
  buildLimbTools,
  buildMemoryTools,
  buildSignalTools,
  parseToolsetEnv,
} from '../src/server-toolsets.js';

const names = ['cat_cafe_collective_current_context', 'cat_cafe_collective_read_context', 'cat_cafe_collective_reply'];
test('real mounted participation profile exposes only three canonical collab tools across every entrypoint', () => {
  const env = parseToolsetEnv({
    CAT_CAFE_MCP_PROFILE: 'collective-participation',
    CAT_CAFE_AGENT_KEY_SECRET: 'cannot-expand',
    CAT_CAFE_DESKTOP_MODE: 'cloud-pro-phase0',
  });
  assert.deepEqual(
    buildCollabTools(env)
      .map((t) => t.name)
      .sort(),
    names,
  );
  for (const build of [buildMemoryTools, buildLimbTools, buildAudioTools, buildFinanceTools, buildSignalTools])
    assert.deepEqual(build(env), []);
  assert.throws(() => parseToolsetEnv({ CAT_CAFE_MCP_PROFILE: 'misspelled' }), /Unknown/);
  for (const name of names) assert.ok(buildCollabTools({}).find((t) => t.name === name));
});
