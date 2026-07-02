import assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';
import { OpenCodeAgentService } from '../dist/domains/cats/services/agents/providers/OpenCodeAgentService.js';
import { generateOpenCodeConfig } from '../dist/domains/cats/services/agents/providers/opencode-config-template.js';
import { collect, createMockProcess, emitOpenCodeEvents } from './helpers/opencode-test-helpers.js';

const STEP_START = {
  type: 'step_start',
  timestamp: 1773304958492,
  sessionID: 'ses_mcp_test',
  part: { type: 'step-start', id: 'prt_1', sessionID: 'ses_mcp_test', messageID: 'msg_1' },
};
const TEXT_RESPONSE = {
  type: 'text',
  timestamp: 1773304958494,
  sessionID: 'ses_mcp_test',
  part: { type: 'text', text: 'Done.' },
};
const STEP_FINISH = {
  type: 'step_finish',
  timestamp: 1773304958508,
  sessionID: 'ses_mcp_test',
  part: { type: 'step-finish', reason: 'stop', cost: 0.01, tokens: { total: 5000 } },
};

async function invokeOpenCode(invokeOptions = {}, serviceOptions = {}) {
  const proc = createMockProcess();
  const spawnFn = mock.fn(() => proc);
  const service = new OpenCodeAgentService({
    catId: 'opencode',
    spawnFn,
    model: 'claude-haiku-4-5',
    ...serviceOptions,
  });

  const promise = collect(service.invoke('Test', invokeOptions));
  emitOpenCodeEvents(proc, [STEP_START, TEXT_RESPONSE, STEP_FINISH]);
  const messages = await promise;

  return { messages, spawnFn };
}

async function invokeOpenCodeAndCaptureArgs(invokeOptions = {}, serviceOptions = {}) {
  const { spawnFn } = await invokeOpenCode(invokeOptions, serviceOptions);
  return spawnFn.mock.calls[0].arguments[1];
}

// Clowder AI MCP env var names used in assertions below

describe('MCP Tool Namespace Isolation (AC-10)', () => {
  // ── buildEnv does not pass Clowder AI MCP env vars ──

  test('buildEnv does not forward CAT_CAFE_MCP_* env vars to child process', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new OpenCodeAgentService({
      catId: 'opencode',
      spawnFn,
      model: 'claude-haiku-4-5',
    });

    // Simulate callbackEnv with Clowder AI MCP vars mixed in
    const callbackEnv = {
      CAT_CAFE_ANTHROPIC_API_KEY: 'sk-test',
      CAT_CAFE_ANTHROPIC_BASE_URL: 'http://proxy:9877/slug',
      CAT_CAFE_MCP_SERVER_URL: 'http://localhost:3003/mcp',
      CAT_CAFE_MCP_TOKEN: 'secret-mcp-token',
      CAT_CAFE_MCP_ENDPOINT: 'ws://localhost:3003/mcp/ws',
    };

    const promise = collect(service.invoke('Test', { callbackEnv }));
    emitOpenCodeEvents(proc, [STEP_START, TEXT_RESPONSE, STEP_FINISH]);
    await promise;

    const opts = spawnFn.mock.calls[0].arguments[2];
    const childEnv = opts.env;

    // Clowder AI MCP vars should either be absent or passthrough as-is
    // (they are harmless because opencode doesn't read them),
    // but they must NOT be mapped to opencode's own MCP config vars.
    // opencode reads MCP config from opencode.json, not env vars.

    // Verify no OPENCODE_MCP_* vars were created from Clowder AI vars
    const opencodeMcpKeys = Object.keys(childEnv).filter(
      (k) => k.startsWith('OPENCODE_MCP_') || k === 'MCP_SERVER_URL',
    );
    assert.strictEqual(opencodeMcpKeys.length, 0, `should not create opencode MCP env vars, found: ${opencodeMcpKeys}`);
  });

  // ── opencode CLI is invoked without --mcp-server flags ──

  test('opencode CLI args do not include MCP server configuration', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new OpenCodeAgentService({
      catId: 'opencode',
      spawnFn,
      model: 'claude-haiku-4-5',
    });

    const promise = collect(service.invoke('Test'));
    emitOpenCodeEvents(proc, [STEP_START, TEXT_RESPONSE, STEP_FINISH]);
    await promise;

    const args = spawnFn.mock.calls[0].arguments[1];
    // No --mcp-server or --mcp flags should be in args
    const mcpArgs = args.filter((a) => typeof a === 'string' && a.includes('mcp'));
    assert.strictEqual(mcpArgs.length, 0, `CLI args should not contain MCP flags, found: ${mcpArgs}`);
  });

  // ── buildEnv cleans up intermediate vars ──

  test('OPENCODE_API_KEY and OPENCODE_BASE_URL are removed from child env', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new OpenCodeAgentService({
      catId: 'opencode',
      spawnFn,
      model: 'claude-haiku-4-5',
    });

    const promise = collect(service.invoke('Test'));
    emitOpenCodeEvents(proc, [STEP_START, TEXT_RESPONSE, STEP_FINISH]);
    await promise;

    const opts = spawnFn.mock.calls[0].arguments[2];
    const childEnv = opts.env;

    // buildEnv sets these to null → buildChildEnv deletes them from process.env copy.
    // This prevents OPENCODE_API_KEY/BASE_URL from parent env leaking to child,
    // ensuring opencode reads ANTHROPIC_API_KEY/BASE_URL instead.
    assert.ok(!('OPENCODE_API_KEY' in childEnv), 'OPENCODE_API_KEY should be deleted from child env');
    assert.ok(!('OPENCODE_BASE_URL' in childEnv), 'OPENCODE_BASE_URL should be deleted from child env');
  });

  // ── Process boundary: opencode reads MCP config from opencode.json, not Clowder AI ──

  test('opencode MCP config is file-based (opencode.json), not env-based', () => {
    // Verify that generateOpenCodeConfig does NOT produce an mcp section.
    // opencode reads MCP config from opencode.json; Clowder AI serves MCP via
    // its own mcp-server package. The config template must NOT bridge them.
    const config = generateOpenCodeConfig({
      apiKey: 'sk-test',
      baseUrl: 'https://proxy.example/v1',
      model: 'claude-sonnet-4-6',
    });

    // No MCP section means no Clowder AI tools leak into opencode's namespace
    assert.strictEqual(config.mcp, undefined, 'generated config must not have mcp section');
    assert.strictEqual(config.provider.anthropic.options.apiKey, undefined, 'apiKey must stay in env');

    // Verify Clowder AI MCP tool prefix convention is distinct from opencode's tools
    // (opencode tools: bash/read/write/..., Clowder AI MCP: cat_cafe_*)
    const serialized = JSON.stringify(config);
    assert.ok(!serialized.includes('cat_cafe'), 'no cat_cafe references in opencode config');
    assert.ok(!serialized.includes('cat-cafe'), 'no cat-cafe references in opencode config');
  });

  // ── No Clowder AI MCP tool names in opencode's internal toolset ──

  test('opencode internal tools do not collide with Clowder AI MCP tool names', () => {
    const opencodeTools = [
      'bash',
      'read',
      'write',
      'edit',
      'glob',
      'grep',
      'delegate-task',
      'list-sessions',
      'webfetch',
      'todoreplace',
    ];

    const catCafeMcpTools = [
      'cat_cafe_post_message',
      'cat_cafe_get_pending_mentions',
      'cat_cafe_ack_mentions',
      'cat_cafe_get_thread_context',
      'cat_cafe_search_messages',
      'cat_cafe_list_threads',
      'cat_cafe_feat_index',
      'cat_cafe_cross_post_message',
      'cat_cafe_list_tasks',
      'cat_cafe_update_task',
      'cat_cafe_create_rich_block',
      'cat_cafe_request_permission',
      'cat_cafe_search_evidence',
      // cat_cafe_reflect removed in F193 Phase D AC-D1
      'cat_cafe_multi_mention',
      'cat_cafe_start_vote',
      'cat_cafe_update_workflow',
      'cat_cafe_register_pr_tracking',
    ];

    // Verify zero overlap
    const overlap = opencodeTools.filter((t) => catCafeMcpTools.includes(t));
    assert.strictEqual(overlap.length, 0, `tool name collision detected: ${overlap}`);

    // Also verify by prefix convention: Clowder AI uses cat_cafe_ prefix
    for (const tool of opencodeTools) {
      assert.ok(!tool.startsWith('cat_cafe_'), `opencode tool "${tool}" collides with Clowder AI MCP namespace`);
    }
  });
});

describe('OpenCode headless permission mode', () => {
  test('opencode CLI args auto-approve permissions in headless JSON mode', async () => {
    const args = await invokeOpenCodeAndCaptureArgs();

    assert.ok(args.includes('--format'), 'must run in JSON event stream mode');
    assert.ok(args.includes('--auto'), 'must auto-approve permissions for headless runs');
    assert.equal(args.filter((arg) => arg === '--auto').length, 1, 'must inject auto-approval flag exactly once');
  });

  test('opencode CLI args do not duplicate user-provided --auto', async () => {
    const args = await invokeOpenCodeAndCaptureArgs({ cliConfigArgs: ['--auto'] });

    assert.ok(args.includes('--auto'), 'must preserve user-provided public auto-approval flag');
    assert.equal(args.filter((arg) => arg === '--auto').length, 1, 'must not duplicate auto-approval aliases');
  });

  test('opencode CLI args let user-provided legacy alias replace default --auto', async () => {
    const args = await invokeOpenCodeAndCaptureArgs({ cliConfigArgs: ['--dangerously-skip-permissions'] });

    assert.ok(args.includes('--dangerously-skip-permissions'), 'must preserve user-provided legacy alias');
    assert.equal(
      args.filter((arg) => arg === '--auto').length,
      0,
      'must not inject --auto when user controls approval',
    );
  });

  test('opencode auto-approval probe rejects CLIs without --auto support', async () => {
    const { messages, spawnFn } = await invokeOpenCode(
      {},
      {
        autoApproveProbeFn: async () => ({
          supported: false,
          message: 'OpenCode 版本过低，不支持 --auto 自动审批；请升级 opencode-ai 到 >= 1.17.12 后重试。',
        }),
      },
    );

    assert.equal(spawnFn.mock.calls.length, 0, 'must not launch opencode run when --auto is unsupported');
    const error = messages.find((message) => message.type === 'error');
    assert.ok(error, 'must yield an error message');
    assert.match(error.error, /升级 opencode-ai 到 >= 1\.17\.12/);
  });

  test('opencode auto-approval probe failure surfaces upgrade guidance', async () => {
    const { messages, spawnFn } = await invokeOpenCode(
      {},
      {
        autoApproveProbeFn: async () => ({
          supported: false,
          message: '无法确认 OpenCode 是否支持 --auto 自动审批；请升级 opencode-ai 到 >= 1.17.12 后重试。',
        }),
      },
    );

    assert.equal(spawnFn.mock.calls.length, 0, 'must not launch opencode run when --auto support is unknown');
    const error = messages.find((message) => message.type === 'error');
    assert.ok(error, 'must yield an error message');
    assert.match(error.error, /无法确认 OpenCode 是否支持 --auto/);
  });
});
