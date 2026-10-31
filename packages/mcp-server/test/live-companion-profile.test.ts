import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCollabTools, buildLimbTools, buildMemoryTools, parseToolsetEnv } from '../src/server-toolsets.js';

test('Live profile cannot boot with a borrowed ambient identity', () => {
  assert.throws(
    () =>
      parseToolsetEnv({
        CAT_CAFE_DESKTOP_MODE: 'live-companion',
        CAT_CAFE_INVOCATION_ID: 'ambient',
        CAT_CAFE_CALLBACK_TOKEN: 'ambient',
      }),
    /native invocation binding/,
  );
});

test('Live gets memory drilldown, coordination and its scoped Task lifecycle without operational tools', () => {
  const env = { desktopMode: 'live-companion' };
  const names = new Set([...buildCollabTools(env), ...buildMemoryTools(env)].map((tool) => tool.name));
  for (const name of [
    'search_evidence',
    'graph_resolve',
    'list_recent',
    'read_file_slice',
    'get_thread_context',
    'get_message',
    'read_session_events',
    'read_profile',
    'recall_person_relationship',
    'list_tasks',
    'cross_post_message',
    'preview_open',
    'admit_entrusted_work',
    'read_entrusted_work',
    'update_entrusted_work',
    'update_task',
    'close_entrusted_work',
  ])
    assert.ok(names.has(`cat_cafe_${name}`), name);
  for (const name of [
    'complete_a2a_dispatch',
    'shell_exec',
    'propose_thread',
    'propose_profile_update',
    'forget_person',
    'create_task',
    'library_archive',
    'library_list',
    'register_schedule',
    'audio_capture_start',
  ])
    assert.ok(!names.has(`cat_cafe_${name}`), name);
  assert.deepEqual(buildLimbTools(env), []);
});
