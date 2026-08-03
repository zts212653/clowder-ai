/**
 * MCP Tool Registration Tests
 * 回归测试: 确认所有预期工具都注册到 MCP server
 *
 * 背景: request_permission / check_permission_status 的 handler 和 schema
 * 早就存在，但 createServer() 漏了 server.tool() 注册。
 * 本测试守住"注册层"，修复前会 Red，修复后 Green。
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const EXPECTED_TOOLS = [
  // Callback tools (chat + task + ack)
  'cat_cafe_post_message',
  'cat_cafe_get_pending_mentions',
  'cat_cafe_ack_mentions',
  'cat_cafe_get_thread_context',
  // #699: Message lookup by ID
  'cat_cafe_get_message',
  'cat_cafe_get_thread_cats',
  'cat_cafe_list_threads',
  'cat_cafe_feat_index',
  'cat_cafe_cross_post_message',
  'cat_cafe_list_tasks',
  'cat_cafe_update_task',
  // F160 Phase A: create-task
  'cat_cafe_create_task',
  'cat_cafe_create_rich_block',
  'cat_cafe_generate_document',
  'cat_cafe_workspace_navigate',
  'cat_cafe_preview_open',
  // F227: generic teleport to a thread message
  'cat_cafe_teleport',
  // F227 Task 7: Event Memory timeline read + corpus backfill
  'cat_cafe_list_events',
  'cat_cafe_backfill_events',
  'cat_cafe_get_rich_block_rules',
  'cat_cafe_register_pr_tracking',
  'cat_cafe_register_issue_tracking',
  'cat_cafe_unregister_tracking',
  'cat_cafe_record_external_review_verdict',
  'cat_cafe_record_local_review_verdict',
  // F211 Phase B: IDE-direct external runtime session registration
  'cat_cafe_register_external_runtime_session',
  // Guide tools (cat_cafe_guide_resolve legacy alias removed in F193 Phase D AC-D2)
  'cat_cafe_update_guide_state',
  'cat_cafe_get_available_guides',
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
  // F128: Cat-initiated thread proposal
  'cat_cafe_propose_thread',
  'cat_cafe_withdraw_thread_proposal',
  // F225: Cat-initiated session handoff proposal
  'cat_cafe_propose_session_handoff',
  // F231 Phase C: Cat-initiated profile-update proposal
  'cat_cafe_propose_profile_update',
  // F231 Phase D: authenticated current-persona profile read
  'cat_cafe_read_profile',
  // F255 Phase A: private-time settlement and owner-scoped diary reads
  'cat_cafe_settle_present_loop',
  'cat_cafe_read_diary',
  'cat_cafe_list_diaries',
  'cat_cafe_preview_cat_life_settings',
  // F221 Phase B: Cat-initiated taste proposal
  'cat_cafe_propose_taste',
  // F260 Phase A: Cat-initiated entity registration proposal
  'cat_cafe_propose_entity',
  // F276: owner-private people and relationship memory lifecycle
  'cat_cafe_propose_person_memory',
  // F282 Phase D: explicit enum-only abstention for the current derived opportunity
  'cat_cafe_record_proactive_memory_abstention',
  'cat_cafe_get_person_memory_proposal_status',
  'cat_cafe_recall_person_relationship',
  'cat_cafe_drill_person_memory',
  // F287: owner-scoped generic cue drill + content-free outcome.
  'cat_cafe_drill_memory_cue',
  'cat_cafe_record_memory_cue_outcome',
  'cat_cafe_correct_person_claim',
  'cat_cafe_retire_person_claim',
  'cat_cafe_amend_person_interaction',
  'cat_cafe_redact_person_memory_item',
  'cat_cafe_forget_person',
  'cat_cafe_forget_person_memory_proposal',
  // Callback-scoped memory tools
  'cat_cafe_retain_memory_callback',
  // Direct evidence tools (cat_cafe_reflect removed in F193 Phase D AC-D1)
  'cat_cafe_search_evidence',
  'cat_cafe_run_perspective',
  'cat_cafe_read_file_slice',
  // F188 Phase F AC-F1: agent-facing graph navigation
  'cat_cafe_graph_resolve',
  // F188 Phase F AC-F2: time-based browse for cold-start
  'cat_cafe_list_recent',
  // F188 Phase I AC-I4: library lifecycle MCP tools
  'cat_cafe_library_list',
  'cat_cafe_library_dry_run',
  'cat_cafe_library_create',
  'cat_cafe_library_rebuild',
  'cat_cafe_library_archive',
  'cat_cafe_library_verify',
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
  'cat_cafe_list_external_runtime_sessions',
  'cat_cafe_read_external_runtime_session',
  // Limb tools (3-step flow: list_available → list_tools → invoke_tool)
  'limb_list_available',
  'limb_list_tools',
  'limb_invoke_tool',
  'limb_pair_list',
  'limb_pair_approve',
  'limb_bind_embodiment',
  // F101 Phase I: Game action tool
  'cat_cafe_submit_game_action',
  // F139 Phase 3A: Schedule tools
  'cat_cafe_list_schedule_templates',
  'cat_cafe_preview_scheduled_task',
  'cat_cafe_register_scheduled_task',
  'cat_cafe_remove_scheduled_task',
  'cat_cafe_hold_ball',
  'cat_cafe_list_labels',
  // F061 Bug-F workaround: MCP shell exec for read-only commands
  'cat_cafe_shell_exec',
  // F236 Phase C: cc native Read/Grep/Glob anchor mode control
  'cat_cafe_set_read_mode',
  // #872: Thread Metadata MCP
  'cat_cafe_get_thread_metadata',
  'cat_cafe_set_thread_metadata',
  // F195 Phase B: Audio capture + transcription tools
  'cat_cafe_audio_list_sources',
  'cat_cafe_audio_capture_start',
  'cat_cafe_audio_capture_stop',
  'cat_cafe_audio_capture_status',
  'cat_cafe_audio_read_transcript',
  'cat_cafe_audio_enroll_speakers',
  // F195 Phase C3: Advisory mode tools
  'cat_cafe_audio_set_advisory_mode',
  'cat_cafe_audio_set_talking_points',
  // F207 Phase B0: finance fact layer
  'cat_cafe_finance_query',
  // F192 Phase H AC-H4: verdict publishing pipeline (eval cat → MCP → handler)
  'cat_cafe_publish_verdict',
  'cat_cafe_record_eval_lifecycle',
  // F278: duty-cat paw-feel responsibility closure
  'cat_cafe_capture_paw_feel',
  'cat_cafe_list_paw_feel_inbox',
  'cat_cafe_triage_paw_feel',
  // F168 Phase B Task 6: declare awaiting_external state for a community case
  'cat_cafe_community_await_external',
  // F168 Phase D: request assignment and persist the assigned Guardian's durable checklist signoff
  'cat_cafe_community_request_guardian',
  'cat_cafe_community_guardian_signoff',
];

const EXPECTED_COLLAB_TOOLS = [
  'cat_cafe_post_message',
  'cat_cafe_get_pending_mentions',
  'cat_cafe_ack_mentions',
  'cat_cafe_get_thread_context',
  // #699: Message lookup by ID
  'cat_cafe_get_message',
  'cat_cafe_get_thread_cats',
  'cat_cafe_list_threads',
  'cat_cafe_feat_index',
  'cat_cafe_cross_post_message',
  'cat_cafe_list_tasks',
  'cat_cafe_update_task',
  'cat_cafe_create_task',
  'cat_cafe_create_rich_block',
  'cat_cafe_generate_document',
  'cat_cafe_workspace_navigate',
  'cat_cafe_preview_open',
  // F227: generic teleport to a thread message
  'cat_cafe_teleport',
  // F227 Task 7: Event Memory timeline read + corpus backfill
  'cat_cafe_list_events',
  'cat_cafe_backfill_events',
  'cat_cafe_get_rich_block_rules',
  'cat_cafe_request_permission',
  'cat_cafe_check_permission_status',
  'cat_cafe_register_pr_tracking',
  'cat_cafe_register_issue_tracking',
  'cat_cafe_unregister_tracking',
  'cat_cafe_record_external_review_verdict',
  'cat_cafe_record_local_review_verdict',
  // F211 Phase B: IDE-direct external runtime session registration
  'cat_cafe_register_external_runtime_session',
  // F192 Phase H AC-H4: cat_cafe_publish_verdict registered in collab toolset
  'cat_cafe_publish_verdict',
  'cat_cafe_record_eval_lifecycle',
  'cat_cafe_capture_paw_feel',
  'cat_cafe_list_paw_feel_inbox',
  'cat_cafe_triage_paw_feel',
  // cat_cafe_guide_resolve legacy alias removed in F193 Phase D AC-D2
  'cat_cafe_update_guide_state',
  'cat_cafe_get_available_guides',
  'cat_cafe_start_guide',
  'cat_cafe_guide_control',
  'cat_cafe_update_workflow',
  'cat_cafe_multi_mention',
  'cat_cafe_start_vote',
  'cat_cafe_update_bootcamp_state',
  'cat_cafe_bootcamp_env_check',
  // F128: Cat-initiated thread proposal
  'cat_cafe_propose_thread',
  'cat_cafe_withdraw_thread_proposal',
  // F225: Cat-initiated session handoff proposal
  'cat_cafe_propose_session_handoff',
  // F231 Phase C: Cat-initiated profile-update proposal
  'cat_cafe_propose_profile_update',
  // F231 Phase D: authenticated current-persona profile read
  'cat_cafe_read_profile',
  // F255 Phase A: private-time settlement and owner-scoped diary reads
  'cat_cafe_settle_present_loop',
  'cat_cafe_read_diary',
  'cat_cafe_list_diaries',
  'cat_cafe_preview_cat_life_settings',
  // F221 Phase B: Cat-initiated taste proposal
  'cat_cafe_propose_taste',
  // F260 Phase A: Cat-initiated entity registration proposal
  'cat_cafe_propose_entity',
  // F276: owner-private people and relationship memory lifecycle
  'cat_cafe_propose_person_memory',
  // F282 Phase D: explicit enum-only abstention for the current derived opportunity
  'cat_cafe_record_proactive_memory_abstention',
  'cat_cafe_get_person_memory_proposal_status',
  'cat_cafe_recall_person_relationship',
  'cat_cafe_drill_person_memory',
  'cat_cafe_drill_memory_cue',
  'cat_cafe_record_memory_cue_outcome',
  'cat_cafe_correct_person_claim',
  'cat_cafe_retire_person_claim',
  'cat_cafe_amend_person_interaction',
  'cat_cafe_redact_person_memory_item',
  'cat_cafe_forget_person',
  'cat_cafe_forget_person_memory_proposal',
  'cat_cafe_submit_game_action',
  // F139 Phase 3A: Schedule tools
  'cat_cafe_list_schedule_templates',
  'cat_cafe_preview_scheduled_task',
  'cat_cafe_register_scheduled_task',
  'cat_cafe_remove_scheduled_task',
  'cat_cafe_hold_ball',
  'cat_cafe_list_labels',
  // F061 Bug-F workaround: MCP shell exec for read-only commands
  'cat_cafe_shell_exec',
  // F236 Phase C: cc native Read/Grep/Glob anchor mode control
  'cat_cafe_set_read_mode',
  // #872: Thread Metadata MCP
  'cat_cafe_get_thread_metadata',
  'cat_cafe_set_thread_metadata',
  // F168 Phase B Task 6: declare awaiting_external state for a community case
  'cat_cafe_community_await_external',
  'cat_cafe_community_request_guardian',
  'cat_cafe_community_guardian_signoff',
];

const EXPECTED_MEMORY_TOOLS = [
  'cat_cafe_retain_memory_callback',
  'cat_cafe_mark_generalizable',
  'cat_cafe_nominate_for_global',
  'cat_cafe_review_distillation',
  'cat_cafe_search_evidence',
  'cat_cafe_run_perspective',
  'cat_cafe_read_file_slice',
  'cat_cafe_graph_resolve', // F188 Phase F AC-F1
  'cat_cafe_library_list', // F188 Phase I AC-I4
  'cat_cafe_library_dry_run', // F188 Phase I AC-I4
  'cat_cafe_library_create', // F188 Phase I AC-I4
  'cat_cafe_library_rebuild', // F188 Phase I AC-I4
  'cat_cafe_library_archive', // F188 Phase I AC-I4
  'cat_cafe_library_verify', // F188 Phase J AC-J7
  'cat_cafe_list_recent', // F188 Phase F AC-F2
  // cat_cafe_reflect removed in F193 Phase D AC-D1
  'cat_cafe_list_session_chain',
  'cat_cafe_read_session_events',
  'cat_cafe_read_session_digest',
  'cat_cafe_read_invocation_detail',
  'cat_cafe_list_external_runtime_sessions',
  'cat_cafe_read_external_runtime_session',
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

// F193 Phase C: limb tools (布偶猫专属能力 namespace) get their own server.
const EXPECTED_LIMB_TOOLS = [
  'limb_list_available',
  'limb_list_tools',
  'limb_invoke_tool',
  'limb_pair_list',
  'limb_pair_approve',
  'limb_bind_embodiment',
];

// F207 Phase B0: finance fact tools get their own read-only data-plane server.
const EXPECTED_AUDIO_TOOLS = [
  'cat_cafe_audio_list_sources',
  'cat_cafe_audio_capture_start',
  'cat_cafe_audio_capture_stop',
  'cat_cafe_audio_capture_status',
  'cat_cafe_audio_read_transcript',
  'cat_cafe_audio_enroll_speakers',
  'cat_cafe_audio_set_advisory_mode',
  'cat_cafe_audio_set_talking_points',
];

const EXPECTED_FINANCE_TOOLS = ['cat_cafe_finance_query'];

function assertUnique(values, label) {
  assert.equal(new Set(values).size, values.length, `${label} must not contain duplicate tool names`);
}

describe('MCP Server Tool Registration', () => {
  test('expected tool lists stay duplicate-free', () => {
    assertUnique(EXPECTED_TOOLS, 'EXPECTED_TOOLS');
    assertUnique(EXPECTED_COLLAB_TOOLS, 'EXPECTED_COLLAB_TOOLS');
    assertUnique(EXPECTED_MEMORY_TOOLS, 'EXPECTED_MEMORY_TOOLS');
    assertUnique(EXPECTED_SIGNAL_TOOLS, 'EXPECTED_SIGNAL_TOOLS');
    assertUnique(EXPECTED_LIMB_TOOLS, 'EXPECTED_LIMB_TOOLS');
    assertUnique(EXPECTED_AUDIO_TOOLS, 'EXPECTED_AUDIO_TOOLS');
    assertUnique(EXPECTED_FINANCE_TOOLS, 'EXPECTED_FINANCE_TOOLS');
  });

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

  test('get_thread_context description exposes bounded keyword completeness contract', async () => {
    const { createServer } = await import('../dist/index.js');
    const server = createServer();
    const threadContextTool = server._registeredTools.cat_cafe_get_thread_context;

    assert.ok(threadContextTool, 'get_thread_context tool should exist');
    assert.match(threadContextTool.description, /Use when:/);
    assert.match(threadContextTool.description, /NOT for:/);
    assert.match(threadContextTool.description, /Output:/);
    assert.match(threadContextTool.description, /GOTCHA:/);
    assert.match(threadContextTool.description, /best-effort over a bounded recent scan/);
    assert.match(threadContextTool.description, /scanCapped=true/);
    assert.match(threadContextTool.description, /older history may contain additional matches/);
  });

  // F167 Phase P fix: hold_ball description must steer "等人" to @co-creator/@cat, NOT hold_ball,
  // and scope wakeWhen to local commands (concept-boundary hardening — primary root cause).
  test('hold_ball description excludes "等人" waits and scopes wakeWhen (F167 Phase P)', async () => {
    const { createServer } = await import('../dist/index.js');
    const server = createServer();
    const holdTool = server._registeredTools.cat_cafe_hold_ball;
    assert.ok(holdTool, 'hold_ball tool should exist');
    const desc = holdTool.description;
    assert.ok(typeof desc === 'string' && desc.length > 0, 'hold_ball must have a description string');
    // #1-misuse exclusion: waiting on a person's reply is @co-creator/@cat, never a hold.
    assert.match(desc, /waiting for co-creator\/user OR another cat to reply/);
    assert.match(desc, /redundant 2nd trigger/);
    // an inbound co-creator/cat message counts as a callback (Phase M clarifier extension)
    assert.match(desc, /sending a message into this thread IS such a callback/);
    // wakeWhen scoped to local commands, not a universal "smart wait"
    assert.match(desc, /LOCAL COMMANDS ONLY/);
  });

  test('post_message schema exposes threadId as optional (F178 agent-key auth)', async () => {
    const { createServer } = await import('../dist/index.js');
    const server = createServer();

    const postTool = server._registeredTools.cat_cafe_post_message;
    assert.ok(postTool, 'post_message tool should exist');
    const shapeKeys = Object.keys(postTool.inputSchema.shape);
    assert.ok(
      shapeKeys.includes('threadId'),
      'post_message must expose threadId for agent-key auth (F178 — no default invocation thread)',
    );
    assert.ok(
      postTool.inputSchema._def.shape().threadId.isOptional(),
      'post_message threadId must be optional (backward-compatible for invocation auth)',
    );
    assert.ok(
      shapeKeys.includes('agentKeyCatId'),
      'post_message must expose agentKeyCatId for shared persistent MCP variant identity',
    );
    assert.ok(
      postTool.inputSchema._def.shape().agentKeyCatId.isOptional(),
      'post_message agentKeyCatId stays schema-optional for invocation auth; shared persistent agent-key auth requires it at runtime',
    );
    assert.ok(shapeKeys.includes('action'), 'post_message must expose the same-thread structured successor action');
    assert.ok(
      postTool.inputSchema._def.shape().action.isOptional(),
      'post_message action stays optional for ordinary notifications',
    );
    assert.match(postTool.description, /same-thread structured single successor/i);
    assert.match(postTool.description, /multi_mention.*parallel/i);
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
    assert.ok(
      shapeKeys.includes('agentKeyCatId'),
      'cross_post_message must expose agentKeyCatId for shared persistent MCP variant identity',
    );
  });

  test('structured action descriptions expose the canonical subjectRef grammar (F177 production friction)', async () => {
    const { createServer } = await import('../dist/index.js');
    const server = createServer();

    for (const toolName of ['cat_cafe_post_message', 'cat_cafe_cross_post_message', 'cat_cafe_multi_mention']) {
      const tool = server._registeredTools[toolName];
      assert.ok(tool, `${toolName} tool should exist`);
      const actionDescription = tool.inputSchema._def.shape().action.description;
      assert.match(actionDescription, /pr:<owner>\/<repo>#<positive-number>/, toolName);
      assert.match(actionDescription, /subject:<namespace>:<opaque-id>/, toolName);
      assert.match(actionDescription, /SHA suffixes.*invalid/i, toolName);
    }
  });

  test('thread-context and list-threads expose agentKeyCatId for shared persistent MCP identity', async () => {
    const { createServer } = await import('../dist/index.js');
    const server = createServer();

    const contextTool = server._registeredTools.cat_cafe_get_thread_context;
    const listTool = server._registeredTools.cat_cafe_list_threads;
    assert.ok(contextTool, 'get_thread_context tool should exist');
    assert.ok(listTool, 'list_threads tool should exist');
    assert.ok(Object.keys(contextTool.inputSchema.shape).includes('agentKeyCatId'));
    assert.ok(contextTool.inputSchema._def.shape().agentKeyCatId.isOptional());
    assert.ok(Object.keys(listTool.inputSchema.shape).includes('agentKeyCatId'));
    assert.ok(listTool.inputSchema._def.shape().agentKeyCatId.isOptional());
  });

  test('thread-context description does not discourage the full contiguous freshness path', async () => {
    const { callbackTools } = await import('../dist/tools/callback-tools.js');
    const tool = callbackTools.find((candidate) => candidate.name === 'cat_cafe_get_thread_context');
    assert.ok(tool);
    assert.match(tool.description, /freshness notice/i);
    assert.match(tool.description, /same-target queued bodies/i);
    assert.match(tool.description, /GOTCHA:/);
    assert.doesNotMatch(tool.description, /full" ONLY.*bulk analysis, export/i);
  });

  test('Hub action tools expose agentKeyCatId for shared persistent MCP identity', async () => {
    const { createServer } = await import('../dist/index.js');
    const server = createServer();

    const workspaceTool = server._registeredTools.cat_cafe_workspace_navigate;
    const previewTool = server._registeredTools.cat_cafe_preview_open;
    assert.ok(workspaceTool, 'workspace_navigate tool should exist');
    assert.ok(previewTool, 'preview_open tool should exist');
    assert.ok(Object.keys(workspaceTool.inputSchema.shape).includes('agentKeyCatId'));
    assert.ok(workspaceTool.inputSchema._def.shape().agentKeyCatId.isOptional());
    assert.ok(Object.keys(previewTool.inputSchema.shape).includes('agentKeyCatId'));
    assert.ok(previewTool.inputSchema._def.shape().agentKeyCatId.isOptional());
  });

  test('Schedule setup tools expose agentKeyCatId for shared persistent MCP identity', async () => {
    const { createServer } = await import('../dist/index.js');
    const server = createServer();

    const setupToolNames = [
      'cat_cafe_list_schedule_templates',
      'cat_cafe_preview_scheduled_task',
      'cat_cafe_register_scheduled_task',
    ];

    for (const name of setupToolNames) {
      const tool = server._registeredTools[name];
      assert.ok(tool, `${name} should exist`);
      assert.ok(
        Object.keys(tool.inputSchema.shape).includes('agentKeyCatId'),
        `${name} must expose agentKeyCatId for shared persistent MCP variant identity`,
      );
      assert.ok(tool.inputSchema._def.shape().agentKeyCatId.isOptional(), `${name} agentKeyCatId must be optional`);
    }
  });

  test('agent-key collab allowlist exposes agentKeyCatId on callback-backed tools', async () => {
    const { createServer } = await import('../dist/index.js');
    const { AGENT_KEY_TOOLS } = await import('../dist/server-toolsets.js');
    const server = createServer();
    const missing = [];

    for (const name of AGENT_KEY_TOOLS) {
      const tool = server._registeredTools[name];
      assert.ok(tool, `${name} should be registered before it is allowlisted`);
      const shape = tool.inputSchema?._def?.shape?.() ?? tool.inputSchema?.shape ?? tool.inputSchema;
      if (!shape?.agentKeyCatId) {
        missing.push(name);
        continue;
      }
      assert.equal(shape.agentKeyCatId.isOptional(), true, `${name} agentKeyCatId must be optional`);
    }

    assert.deepEqual(missing, []);
  });

  test('agent-key collab allowlist excludes invocation-record-only and non-principal tools', async () => {
    const { AGENT_KEY_TOOLS } = await import('../dist/server-toolsets.js');
    const agentKeyUnsafeTools = [
      'cat_cafe_get_pending_mentions',
      'cat_cafe_ack_mentions',
      'cat_cafe_get_thread_cats',
      'cat_cafe_feat_index',
      'cat_cafe_list_tasks',
      'cat_cafe_update_task',
      'cat_cafe_create_task',
      'cat_cafe_create_rich_block',
      'cat_cafe_generate_document',
      'cat_cafe_request_permission',
      'cat_cafe_check_permission_status',
      'cat_cafe_register_pr_tracking',
      'cat_cafe_register_issue_tracking',
      'cat_cafe_community_await_external',
      'cat_cafe_update_workflow',
      'cat_cafe_multi_mention',
      'cat_cafe_start_vote',
      'cat_cafe_propose_thread',
      'cat_cafe_propose_session_handoff',
      'cat_cafe_propose_profile_update',
      'cat_cafe_propose_taste',
      'cat_cafe_update_bootcamp_state',
      'cat_cafe_bootcamp_env_check',
      'cat_cafe_update_guide_state',
      'cat_cafe_get_available_guides',
      'cat_cafe_start_guide',
      'cat_cafe_guide_control',
      'cat_cafe_hold_ball',
      'cat_cafe_get_thread_metadata',
      'cat_cafe_set_thread_metadata',
      'cat_cafe_set_read_mode',
      // Game action uses game-phase env identity headers rather than agent-key principal auth.
      'cat_cafe_submit_game_action',
    ];

    const exposed = agentKeyUnsafeTools.filter((name) => AGENT_KEY_TOOLS.has(name));
    assert.deepEqual(exposed, []);
  });

  test('agent-key collab allowlist is the route-principal-backed surface', async () => {
    const { AGENT_KEY_TOOLS } = await import('../dist/server-toolsets.js');
    const expected = [
      'cat_cafe_backfill_events',
      'cat_cafe_cross_post_message',
      'cat_cafe_get_message',
      'cat_cafe_get_thread_context',
      'cat_cafe_list_events',
      'cat_cafe_list_labels',
      'cat_cafe_list_paw_feel_inbox',
      'cat_cafe_list_schedule_templates',
      'cat_cafe_list_threads',
      'cat_cafe_post_message',
      'cat_cafe_preview_open',
      'cat_cafe_preview_scheduled_task',
      'cat_cafe_publish_verdict',
      'cat_cafe_record_eval_lifecycle',
      'cat_cafe_read_diary',
      'cat_cafe_read_profile',
      'cat_cafe_list_diaries',
      'cat_cafe_get_person_memory_proposal_status',
      'cat_cafe_recall_person_relationship',
      'cat_cafe_drill_person_memory',
      'cat_cafe_register_external_runtime_session',
      'cat_cafe_community_request_guardian',
      'cat_cafe_community_guardian_signoff',
      'cat_cafe_register_scheduled_task',
      'cat_cafe_remove_scheduled_task',
      'cat_cafe_teleport',
      'cat_cafe_triage_paw_feel',
      'cat_cafe_workspace_navigate',
    ];

    assert.deepEqual([...AGENT_KEY_TOOLS].sort(), expected.sort());
  });

  test('non-agent-key collab tools do not expose dead agentKeyCatId schema', async () => {
    const { createServer } = await import('../dist/index.js');
    const { AGENT_KEY_TOOLS, buildCollabTools } = await import('../dist/server-toolsets.js');
    const server = createServer();
    const collabNames = buildCollabTools({ readonly: false }).map((tool) => tool.name);
    const offenders = [];

    for (const name of collabNames) {
      if (AGENT_KEY_TOOLS.has(name)) continue;
      const tool = server._registeredTools[name];
      assert.ok(tool, `${name} should be registered before schema inspection`);
      const shape = tool.inputSchema?._def?.shape?.() ?? tool.inputSchema?.shape ?? tool.inputSchema;
      if (shape?.agentKeyCatId) offenders.push(name);
    }

    assert.deepEqual(offenders, []);
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

  test('cat_cafe_update_workflow exposes optional taskId for deterministic backlog import', async () => {
    const { createCollabServer } = await import('../dist/collab.js');
    const tool = createCollabServer()._registeredTools.cat_cafe_update_workflow;
    assert.ok(tool);
    const shape = tool.inputSchema._def.shape();
    assert.equal(shape.taskId.isOptional(), true);
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

  test('F193 AC-C1: createLimbServer registers only limb tool surface', async () => {
    const { createLimbServer } = await import('../dist/limb.js');
    const server = createLimbServer();
    const registered = Object.keys(server._registeredTools);

    assert.deepEqual([...registered].sort(), [...EXPECTED_LIMB_TOOLS].sort());
  });

  test('F195: createAudioServer registers only audio tool surface', async () => {
    const { createAudioServer } = await import('../dist/audio.js');
    const server = createAudioServer();
    const registered = Object.keys(server._registeredTools);

    assert.deepEqual([...registered].sort(), [...EXPECTED_AUDIO_TOOLS].sort());
  });

  test('F207 AC-B5: createFinanceServer registers only finance fact tool surface', async () => {
    const { createFinanceServer } = await import('../dist/finance.js');
    const server = createFinanceServer();
    const registered = Object.keys(server._registeredTools);

    assert.deepEqual([...registered].sort(), [...EXPECTED_FINANCE_TOOLS].sort());
  });
});

// --- F061 Phase 2: READONLY_ALLOWED_TOOLS whitelist ---

const KNOWN_WRITE_TOOLS = [
  'cat_cafe_post_message',
  'cat_cafe_ack_mentions',
  'cat_cafe_cross_post_message',
  'cat_cafe_multi_mention',
  'cat_cafe_update_task',
  'cat_cafe_create_task',
  'cat_cafe_create_rich_block',
  'cat_cafe_generate_document',
  'cat_cafe_workspace_navigate',
  'cat_cafe_preview_open',
  // F227: generic teleport (write — agent-key gated, not in readonly)
  'cat_cafe_teleport',
  // F227 Task 7: backfill is a write (agent-key gated, not in readonly)
  'cat_cafe_backfill_events',
  'cat_cafe_request_permission',
  'cat_cafe_register_pr_tracking',
  'cat_cafe_register_issue_tracking',
  'cat_cafe_unregister_tracking',
  'cat_cafe_register_external_runtime_session',
  'cat_cafe_update_workflow',
  'cat_cafe_start_vote',
  'cat_cafe_update_bootcamp_state',
  'cat_cafe_bootcamp_env_check', // writes bootcampState.envCheck via callbackPost
  // cat_cafe_guide_resolve legacy alias removed in F193 Phase D AC-D2
  'cat_cafe_update_guide_state',
  'cat_cafe_start_guide',
  'cat_cafe_guide_control',
  'cat_cafe_retain_memory_callback',
  'cat_cafe_mark_generalizable',
  'cat_cafe_nominate_for_global',
  'cat_cafe_review_distillation', // POST approve/reject → writes global knowledge
  'cat_cafe_submit_game_action',
  'cat_cafe_register_scheduled_task',
  'cat_cafe_remove_scheduled_task',
  'cat_cafe_hold_ball', // callbackPost → writes scheduled task
  'cat_cafe_settle_present_loop', // authenticated product settlement
  // F192 Phase H AC-H4: publish verdict creates branch + commit + PR (write)
  'cat_cafe_publish_verdict',
  'cat_cafe_feat_index', // requires callback credentials unavailable in readonly
  // F236 Phase C: set_read_mode writes mode file via callbackPost
  'cat_cafe_set_read_mode',
  // #872: set_thread_metadata writes via callbackPost
  'cat_cafe_set_thread_metadata',
  'signal_mark_read',
  'signal_summarize',
  'signal_start_study',
  'signal_save_notes',
  'signal_generate_podcast',
  'signal_update_article',
  'signal_delete_article',
  'signal_link_thread',
  'limb_invoke_tool',
  'limb_pair_approve',
  'limb_bind_embodiment',
];

const EXPECTED_READONLY_TOOLS = [
  'cat_cafe_search_evidence',
  'cat_cafe_run_perspective',
  'cat_cafe_read_file_slice',
  'cat_cafe_graph_resolve', // F188 Phase F AC-F1
  'cat_cafe_list_recent', // F188 Phase F AC-F2
  // cat_cafe_reflect removed in F193 Phase D AC-D1
  'cat_cafe_get_rich_block_rules',
  'cat_cafe_list_session_chain',
  'cat_cafe_read_session_events',
  'cat_cafe_read_session_digest',
  'cat_cafe_read_invocation_detail',
  'cat_cafe_list_external_runtime_sessions',
  'cat_cafe_read_external_runtime_session',
  'signal_list_inbox',
  'signal_get_article',
  'signal_search',
  'signal_list_studies',
  // F061 Bug-F workaround: read-only shell exec whitelist enforced at handler level
  'cat_cafe_shell_exec',
  // F207 Phase B0: read-only finance fact layer wrapper
  'cat_cafe_finance_query',
];

describe('F061 READONLY_ALLOWED_TOOLS whitelist', () => {
  test('whitelist excludes all known write tools', async () => {
    const { READONLY_ALLOWED_TOOLS } = await import('../dist/server-toolsets.js');
    for (const name of KNOWN_WRITE_TOOLS) {
      assert.ok(!READONLY_ALLOWED_TOOLS.has(name), `Write tool "${name}" must NOT be in readonly whitelist`);
    }
  });

  test('whitelist includes all expected readonly tools', async () => {
    const { READONLY_ALLOWED_TOOLS } = await import('../dist/server-toolsets.js');
    for (const name of EXPECTED_READONLY_TOOLS) {
      assert.ok(READONLY_ALLOWED_TOOLS.has(name), `Readonly tool "${name}" must be in whitelist`);
    }
  });

  test('whitelist is a subset of all registered tools', async () => {
    const { READONLY_ALLOWED_TOOLS } = await import('../dist/server-toolsets.js');
    const { createServer } = await import('../dist/index.js');
    const server = createServer();
    const allRegistered = new Set(Object.keys(server._registeredTools));
    for (const name of READONLY_ALLOWED_TOOLS) {
      assert.ok(allRegistered.has(name), `Whitelist tool "${name}" does not exist in registered tools`);
    }
  });

  test('readonly + agent-key exposes only readonly, principal-capable, or non-callback-safe collab tools', async () => {
    const { buildCollabTools } = await import('../dist/server-toolsets.js');
    const agentKeyNames = new Set(buildCollabTools({ readonly: true, hasAgentKey: true }).map((tool) => tool.name));
    const expected = [
      'cat_cafe_post_message',
      'cat_cafe_cross_post_message',
      'cat_cafe_get_thread_context',
      'cat_cafe_get_message',
      'cat_cafe_get_rich_block_rules',
      'cat_cafe_list_threads',
      'cat_cafe_list_labels',
      'cat_cafe_list_paw_feel_inbox',
      'cat_cafe_list_schedule_templates',
      'cat_cafe_preview_scheduled_task',
      'cat_cafe_register_scheduled_task',
      'cat_cafe_remove_scheduled_task',
      'cat_cafe_register_external_runtime_session',
      'cat_cafe_community_request_guardian',
      'cat_cafe_community_guardian_signoff',
      'cat_cafe_workspace_navigate',
      'cat_cafe_preview_open',
      'cat_cafe_shell_exec',
      'cat_cafe_teleport',
      'cat_cafe_backfill_events',
      'cat_cafe_list_events',
      'cat_cafe_publish_verdict',
      'cat_cafe_record_eval_lifecycle',
      'cat_cafe_triage_paw_feel',
      'cat_cafe_read_diary',
      'cat_cafe_read_profile',
      'cat_cafe_list_diaries',
      'cat_cafe_get_person_memory_proposal_status',
      'cat_cafe_recall_person_relationship',
      'cat_cafe_drill_person_memory',
    ].sort();

    assert.deepEqual([...agentKeyNames].filter((name) => name.startsWith('cat_cafe_')).sort(), expected);
  });

  test('readonly mode exposes agent-key tools when only CAT_CAFE_AGENT_KEY_FILES is configured', () => {
    const distIndexUrl = new URL('../dist/index.js', import.meta.url).href;
    const script = `
      process.env.CAT_CAFE_READONLY = 'true';
      delete process.env.CAT_CAFE_AGENT_KEY_SECRET;
      delete process.env.CAT_CAFE_AGENT_KEY_FILE;
      process.env.CAT_CAFE_AGENT_KEY_FILES = JSON.stringify({
        antigravity: '/tmp/antigravity.secret',
        'antig-opus': '/tmp/antig-opus.secret',
      });
      const { createServer } = await import(${JSON.stringify(distIndexUrl)});
      const server = createServer();
      const names = Object.keys(server._registeredTools);
      if (
        !names.includes('cat_cafe_post_message') ||
        !names.includes('cat_cafe_get_thread_context') ||
        !names.includes('cat_cafe_workspace_navigate') ||
        !names.includes('cat_cafe_preview_open') ||
        // F227: teleport is agent-key gated — must be visible in readonly+agent-key
        !names.includes('cat_cafe_teleport') ||
        !names.includes('cat_cafe_list_schedule_templates') ||
        !names.includes('cat_cafe_preview_scheduled_task') ||
        !names.includes('cat_cafe_register_scheduled_task') ||
        !names.includes('cat_cafe_remove_scheduled_task') ||
        names.includes('cat_cafe_create_rich_block') ||
        names.includes('cat_cafe_get_thread_cats') ||
        names.includes('cat_cafe_list_tasks') ||
        names.includes('cat_cafe_multi_mention') ||
        names.includes('cat_cafe_hold_ball') ||
        names.includes('cat_cafe_propose_thread') ||
        names.includes('cat_cafe_unregister_tracking') ||
        names.includes('cat_cafe_submit_game_action') ||
        // 砚砚 R9 P1: shared-MCP cats must see publish-verdict
        !names.includes('cat_cafe_publish_verdict')
      ) {
        console.error(JSON.stringify(names.sort()));
        process.exit(1);
      }
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: process.cwd(),
      encoding: 'utf-8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  });
});
