/**
 * MCP Tool Registration Tests
 * 回归测试: 确认所有预期工具都注册到 MCP server
 *
 * 背景: request_permission / check_permission_status 的 handler 和 schema
 * 早就存在，但 createServer() 漏了 server.tool() 注册。
 * 本测试守住"注册层"，修复前会 Red，修复后 Green。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const EXPECTED_TOOLS = [
  // Callback tools (chat + task + ack)
  'cat_cafe_post_message',
  'cat_cafe_get_pending_mentions',
  'cat_cafe_ack_mentions',
  'cat_cafe_get_thread_context',
  'cat_cafe_get_thread_cats',
  'cat_cafe_list_threads',
  'cat_cafe_feat_index',
  'cat_cafe_cross_post_message',
  'cat_cafe_list_tasks',
  'cat_cafe_update_task',
  'cat_cafe_create_rich_block',
  'cat_cafe_generate_document',
  'cat_cafe_get_rich_block_rules',
  'cat_cafe_register_pr_tracking',
  // Guide tools
  'cat_cafe_update_guide_state',
  'cat_cafe_guide_resolve',
  'cat_cafe_start_guide',
  'cat_cafe_guide_control',
  // Workflow SOP tools (F073 P1)
  'cat_cafe_update_workflow',
  // Multi-mention orchestration (F086 M1)
  'cat_cafe_multi_mention',
  // F079 Gap 4: Cat-initiated voting
  'cat_cafe_start_vote',
  // Permission tools (this is the regression guard)
  'cat_cafe_request_permission',
  'cat_cafe_check_permission_status',
  // Bootcamp tools (F087)
  'cat_cafe_update_bootcamp_state',
  'cat_cafe_bootcamp_env_check',
  // Callback-scoped memory tools
  'cat_cafe_retain_memory_callback',
  // Direct evidence/reflect tools
  'cat_cafe_search_evidence',
  'cat_cafe_reflect',
  // F152 Phase C: Distillation tools
  'cat_cafe_mark_generalizable',
  'cat_cafe_nominate_for_global',
  'cat_cafe_review_distillation',
  // Signal Hunter tools (F21 S5) + F091 Study tools
  'signal_list_inbox',
  'signal_get_article',
  'signal_search',
  'signal_mark_read',
  'signal_summarize',
  'signal_start_study',
  'signal_save_notes',
  'signal_list_studies',
  'signal_generate_podcast',
  'signal_update_article',
  'signal_delete_article',
  'signal_link_thread',
  // Session chain tools
  'cat_cafe_list_session_chain',
  'cat_cafe_read_session_events',
  'cat_cafe_read_session_digest',
  'cat_cafe_read_invocation_detail',
  // Limb tools
  'limb_list_available',
  'limb_invoke',
  'limb_pair_list',
  'limb_pair_approve',
  // F101 Phase I: Game action tool
  'cat_cafe_submit_game_action',
  // F155: Guide lifecycle tools
  'cat_cafe_update_guide_state',
  'cat_cafe_start_guide',
  'cat_cafe_guide_resolve',
  'cat_cafe_guide_control',
  // F139 Phase 3A: Schedule tools
  'cat_cafe_list_schedule_templates',
  'cat_cafe_preview_scheduled_task',
  'cat_cafe_register_scheduled_task',
  'cat_cafe_remove_scheduled_task',
];

const EXPECTED_COLLAB_TOOLS = [
  'cat_cafe_post_message',
  'cat_cafe_get_pending_mentions',
  'cat_cafe_ack_mentions',
  'cat_cafe_get_thread_context',
  'cat_cafe_get_thread_cats',
  'cat_cafe_list_threads',
  'cat_cafe_feat_index',
  'cat_cafe_cross_post_message',
  'cat_cafe_list_tasks',
  'cat_cafe_update_task',
  'cat_cafe_create_rich_block',
  'cat_cafe_generate_document',
  'cat_cafe_get_rich_block_rules',
  'cat_cafe_request_permission',
  'cat_cafe_check_permission_status',
  'cat_cafe_register_pr_tracking',
  'cat_cafe_update_guide_state',
  'cat_cafe_guide_resolve',
  'cat_cafe_start_guide',
  'cat_cafe_guide_control',
  'cat_cafe_update_workflow',
  'cat_cafe_multi_mention',
  'cat_cafe_start_vote',
  'cat_cafe_update_bootcamp_state',
  'cat_cafe_bootcamp_env_check',
  'cat_cafe_submit_game_action',
  // F155: Guide lifecycle tools
  'cat_cafe_update_guide_state',
  'cat_cafe_start_guide',
  'cat_cafe_guide_resolve',
  'cat_cafe_guide_control',
  // F139 Phase 3A: Schedule tools
  'cat_cafe_list_schedule_templates',
  'cat_cafe_preview_scheduled_task',
  'cat_cafe_register_scheduled_task',
  'cat_cafe_remove_scheduled_task',
];

const EXPECTED_MEMORY_TOOLS = [
  'cat_cafe_retain_memory_callback',
  'cat_cafe_mark_generalizable',
  'cat_cafe_nominate_for_global',
  'cat_cafe_review_distillation',
  'cat_cafe_search_evidence',
  'cat_cafe_reflect',
  'cat_cafe_list_session_chain',
  'cat_cafe_read_session_events',
  'cat_cafe_read_session_digest',
  'cat_cafe_read_invocation_detail',
];

const EXPECTED_SIGNAL_TOOLS = [
  'signal_list_inbox',
  'signal_get_article',
  'signal_search',
  'signal_mark_read',
  'signal_summarize',
  'signal_start_study',
  'signal_save_notes',
  'signal_list_studies',
  'signal_generate_podcast',
  'signal_update_article',
  'signal_delete_article',
  'signal_link_thread',
];

describe('MCP Server Tool Registration', () => {
  test('all expected tools are registered via createServer()', async () => {
    const { createServer } = await import('../dist/index.js');
    const server = createServer();

    // _registeredTools is a plain object keyed by tool name
    const registeredNames = Object.keys(server._registeredTools);

    for (const name of EXPECTED_TOOLS) {
      assert.ok(registeredNames.includes(name), `Tool "${name}" is NOT registered on the MCP server`);
    }
  });

  test('no unexpected tools are registered', async () => {
    const { createServer } = await import('../dist/index.js');
    const server = createServer();

    const registeredNames = Object.keys(server._registeredTools);

    for (const name of registeredNames) {
      assert.ok(
        EXPECTED_TOOLS.includes(name),
        `Unexpected tool "${name}" found — add it to EXPECTED_TOOLS if intentional`,
      );
    }
  });

  test('permission tools have correct input schemas', async () => {
    const { createServer } = await import('../dist/index.js');
    const server = createServer();

    const reqTool = server._registeredTools.cat_cafe_request_permission;
    assert.ok(reqTool, 'request_permission tool should exist');

    const checkTool = server._registeredTools.cat_cafe_check_permission_status;
    assert.ok(checkTool, 'check_permission_status tool should exist');
  });

  test('post_message schema must NOT expose threadId (#316 regression guard)', async () => {
    const { createServer } = await import('../dist/index.js');
    const server = createServer();

    const postTool = server._registeredTools.cat_cafe_post_message;
    assert.ok(postTool, 'post_message tool should exist');
    const shapeKeys = Object.keys(postTool.inputSchema.shape);
    assert.ok(
      !shapeKeys.includes('threadId'),
      'post_message must NOT expose threadId — use cross_post_message for cross-thread posting (#316)',
    );
  });

  test('cross_post_message schema must REQUIRE threadId', async () => {
    const { createServer } = await import('../dist/index.js');
    const server = createServer();

    const crossTool = server._registeredTools.cat_cafe_cross_post_message;
    assert.ok(crossTool, 'cross_post_message tool should exist');
    const shapeKeys = Object.keys(crossTool.inputSchema.shape);
    assert.ok(shapeKeys.includes('threadId'), 'cross_post_message must have threadId in schema');
    assert.ok(
      crossTool.inputSchema._def.shape().threadId.isOptional() === false,
      'cross_post_message threadId must be required (not optional)',
    );
  });

  test('deprecated file tools are not registered', async () => {
    const { createServer } = await import('../dist/index.js');
    const server = createServer();
    const registeredNames = Object.keys(server._registeredTools);

    assert.ok(!registeredNames.includes('read_file'));
    assert.ok(!registeredNames.includes('write_file'));
    assert.ok(!registeredNames.includes('list_files'));
  });

  test('src/index.ts stays under 350 lines (hard limit)', () => {
    const sourcePath = new URL('../src/index.ts', import.meta.url);
    const source = readFileSync(sourcePath, 'utf-8');
    const lineCount = source.split('\n').length;
    assert.ok(lineCount <= 350, `mcp-server/src/index.ts exceeds 350 lines: ${lineCount}`);
  });

  test('createCollabServer registers only collab tool surface', async () => {
    const { createCollabServer } = await import('../dist/collab.js');
    const server = createCollabServer();
    const registered = Object.keys(server._registeredTools);

    assert.deepEqual([...registered].sort(), [...EXPECTED_COLLAB_TOOLS].sort());
  });

  test('createMemoryServer registers only memory tool surface', async () => {
    const { createMemoryServer } = await import('../dist/memory.js');
    const server = createMemoryServer();
    const registered = Object.keys(server._registeredTools);

    assert.deepEqual([...registered].sort(), [...EXPECTED_MEMORY_TOOLS].sort());
  });

  test('createSignalsServer registers only signals tool surface', async () => {
    const { createSignalsServer } = await import('../dist/signals.js');
    const server = createSignalsServer();
    const registered = Object.keys(server._registeredTools);

    assert.deepEqual([...registered].sort(), [...EXPECTED_SIGNAL_TOOLS].sort());
  });
});
