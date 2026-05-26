/**
 * F153 Phase J Slice J-A AC-J2: provider transformer native id pass-through tests.
 *
 * Verifies that DARE, Codex, and CatAgent provider transformers inject the
 * correct native tool id into AgentMessage.toolUseId and map tool result outcome
 * to the structured AgentMessage.toolResultStatus field — so the call site in
 * invoke-single-cat.ts can route tool_use/tool_result events through
 * ToolSpanTracker for real-duration spans (instead of the legacy zero-duration
 * recordToolUseSpan fallback).
 *
 * Coverage:
 * - DARE: tool.invoke / tool.result / tool.error → toolUseId lifted from
 *   data.tool_call_id; status mapped to ok / error.
 * - Codex: item.started + item.completed of type mcp_tool_call → toolUseId
 *   from item.id; status mapped from item.status (completed=ok, failed/error=error).
 * - CatAgent: stream-parser tool_use block id propagated as toolUseId on the
 *   tool_use AgentMessage (source-string only — full streaming test would
 *   need a mocked HTTP server, out of scope here).
 */

if (!process.env.NODE_ENV) process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── DARE behavioral: tool.invoke + tool.result + tool.error ──────────

const { transformDareEvent } = await import(
  '../../dist/domains/cats/services/agents/providers/dare-event-transform.js'
);

const dareEnv = (event, data, ts = 1.0) => ({
  schema_version: 'client-headless-event-envelope.v1',
  ts,
  session_id: 's',
  run_id: 'r',
  seq: 1,
  event,
  data,
});

test('F153 Phase J AC-J2 DARE: tool.invoke lifts tool_call_id to toolUseId (not toolInput)', () => {
  const msg = transformDareEvent(
    dareEnv('tool.invoke', { tool_name: 'web_search', tool_call_id: 'call_abc123' }),
    'opus',
  );
  assert.equal(msg.type, 'tool_use');
  assert.equal(msg.toolName, 'web_search');
  assert.equal(msg.toolUseId, 'call_abc123', 'tool_call_id lifted to top-level toolUseId');
  assert.equal(msg.toolInput, undefined, 'tool_call_id no longer shoved into toolInput');
});

test('F153 Phase J AC-J2 DARE: tool.result carries toolUseId + toolResultStatus=ok', () => {
  const msg = transformDareEvent(
    dareEnv('tool.result', { tool_name: 'web_search', tool_call_id: 'call_abc123' }),
    'opus',
  );
  assert.equal(msg.type, 'tool_result');
  assert.equal(msg.toolUseId, 'call_abc123');
  assert.equal(msg.toolResultStatus, 'ok');
});

test('F153 Phase J AC-J2 DARE: tool.error carries toolUseId + toolResultStatus=error', () => {
  const msg = transformDareEvent(
    dareEnv('tool.error', { tool_name: 'web_search', tool_call_id: 'call_abc123', error: 'timeout' }),
    'opus',
  );
  assert.equal(msg.type, 'tool_result');
  assert.equal(msg.toolUseId, 'call_abc123');
  assert.equal(msg.toolResultStatus, 'error');
});

test('F153 Phase J AC-J2 DARE: tool.invoke without tool_call_id leaves toolUseId undefined (fallback)', () => {
  const msg = transformDareEvent(dareEnv('tool.invoke', { tool_name: 'web_search' }), 'opus');
  assert.equal(msg.toolUseId, undefined, 'no id → no toolUseId (ToolSpanTracker falls back per KD-41)');
});

// ── Codex behavioral: item.started + item.completed of mcp_tool_call ─

const { transformCodexEvent } = await import(
  '../../dist/domains/cats/services/agents/providers/codex-event-transform.js'
);

test('F153 Phase J AC-J2 Codex: item.started mcp_tool_call → toolUseId from item.id', () => {
  const msg = transformCodexEvent(
    {
      type: 'item.started',
      item: { id: 'item_42', type: 'mcp_tool_call', server: 'cat-cafe', tool: 'post_message', arguments: { x: 1 } },
    },
    'codex',
  );
  assert.equal(msg.type, 'tool_use');
  assert.equal(msg.toolName, 'mcp:cat-cafe/post_message');
  assert.equal(msg.toolUseId, 'item_42', 'item.id is the lifecycle anchor (砚砚 R1 P2-2 finding)');
});

test('F153 Phase J AC-J2 Codex: item.completed mcp_tool_call completed → toolUseId + status=ok', () => {
  const msg = transformCodexEvent(
    {
      type: 'item.completed',
      item: { id: 'item_42', type: 'mcp_tool_call', server: 'cat-cafe', tool: 'post_message', status: 'completed' },
    },
    'codex',
  );
  assert.equal(msg.type, 'tool_result');
  assert.equal(msg.toolUseId, 'item_42');
  assert.equal(msg.toolResultStatus, 'ok', 'completed → ok');
});

test('F153 Phase J AC-J2 Codex: item.completed mcp_tool_call failed → status=error', () => {
  const msg = transformCodexEvent(
    {
      type: 'item.completed',
      item: { id: 'item_42', type: 'mcp_tool_call', server: 'cat-cafe', tool: 'post_message', status: 'failed' },
    },
    'codex',
  );
  assert.equal(msg.toolResultStatus, 'error', 'failed → error');
});

test('F153 Phase J AC-J2 Codex: item.completed mcp_tool_call unknown status → status=unknown', () => {
  const msg = transformCodexEvent(
    {
      type: 'item.completed',
      item: { id: 'item_42', type: 'mcp_tool_call', server: 'cat-cafe', tool: 'post_message', status: 'pending' },
    },
    'codex',
  );
  assert.equal(msg.toolResultStatus, 'unknown', "unrecognized status → 'unknown' (per KD-38 honesty)");
});

// ── CatAgent: source-string assertions (full HTTP-mock test out of scope) ──

test('F153 Phase J AC-J2 CatAgent: stream-parser tool_use yield carries block.id as toolUseId', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/domains/cats/services/agents/providers/catagent/CatAgentService.ts'),
    'utf8',
  );
  // The tool_use AgentMessage yield in mapStreamEvent must include toolUseId from block.id
  // (block.id propagates the Anthropic native tool_use id from the stream parser).
  assert.ok(
    src.includes('toolUseId: evt.block.id'),
    'CatAgent must wire evt.block.id → toolUseId on the tool_use AgentMessage',
  );
});

test('F153 Phase J AC-J2 CatAgent: tool_result for executed tools carries toolUseId + status', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/domains/cats/services/agents/providers/catagent/CatAgentService.ts'),
    'utf8',
  );
  // Normal tool_result path (after executeTools) must carry r.id and structured status.
  assert.ok(src.includes('toolUseId: r.id'), 'CatAgent tool_result must carry r.id as toolUseId');
  assert.ok(
    src.includes("toolResultStatus: isError ? 'error' : 'ok'"),
    'CatAgent must derive status from content "Error:" prefix heuristic',
  );
});

test('F153 Phase J AC-J2 CatAgent: orphan tool_result (stream interrupted) carries toolUseId + status=error', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/domains/cats/services/agents/providers/catagent/CatAgentService.ts'),
    'utf8',
  );
  // Stream-error orphan path must also propagate t.id + mark status=error.
  assert.ok(
    src.includes('toolUseId: t.id') && src.includes("toolResultStatus: 'error'"),
    'CatAgent orphan tool_result must propagate t.id + status=error',
  );
});
