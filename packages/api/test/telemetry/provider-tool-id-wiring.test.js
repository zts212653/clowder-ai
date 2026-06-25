/**
 * F153 Phase J Slice J-A AC-J2: provider transformer native id pass-through tests.
 *
 * Verifies that Codex and CatAgent provider transformers inject the
 * correct native tool id into AgentMessage.toolUseId and map tool result outcome
 * to the structured AgentMessage.toolResultStatus field — so the call site in
 * invoke-single-cat.ts can route tool_use/tool_result events through
 * ToolSpanTracker for real-duration spans (instead of the legacy zero-duration
 * recordToolUseSpan fallback).
 *
 * Coverage:
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
// FRAGILE: these 3 tests use readFileSync + assert.ok(src.includes(...)) on literal
// code patterns and break on variable renames (evt→event, r→result), formatter spacing
// changes, file restructuring, and comment-mentioning the old pattern (for the negative
// assertion below). See PR #774 maintainer R3 P2-2 — the 3 behavioral tests for
// `executeCatAgentTools` (further below) are the real coverage; these 3 are scaffolding
// kept until a mock-HTTP integration test replaces them.

// fragile: source-string assertion, see PR #774 P2-2
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

// fragile: source-string assertion, see PR #774 P2-2
test('F153 Phase J AC-J2 CatAgent: tool_result carries toolUseId + status from executeTools (no content-string heuristic)', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/domains/cats/services/agents/providers/catagent/CatAgentService.ts'),
    'utf8',
  );
  // R1 P2 fix: status comes from r.status (executeTools execution edge),
  // NOT from content.startsWith('Error:') heuristic.
  assert.ok(src.includes('toolUseId: r.id'), 'CatAgent tool_result must carry r.id as toolUseId');
  assert.ok(src.includes('toolResultStatus: r.status'), 'CatAgent must use r.status from executeTools');
  assert.ok(
    !src.includes("startsWith('Error:')"),
    'content-string heuristic must be removed (砚砚 R1 P2 / cloud Codex P2)',
  );
});

// ── CatAgent behavioral: executeCatAgentTools status comes from execution edge ──

const { executeCatAgentTools } = await import(
  '../../dist/domains/cats/services/agents/providers/catagent/CatAgentService.js'
);

const fakeSchema = (name) => ({
  name,
  description: 'test',
  input_schema: { type: 'object', properties: {}, required: [] },
});

test('F153 Phase J AC-J2 CatAgent R1 P2 fix: successful tool returning "Error: literal" content stays status=ok', async () => {
  const blocks = [{ id: 'use-1', type: 'tool_use', name: 'fake_read', input: {} }];
  const tools = [
    {
      name: 'fake_read',
      schema: fakeSchema('fake_read'),
      // Legitimate "Error: 200 OK" log-like content — must NOT be mis-marked as error.
      execute: async () => 'Error: 200 OK from upstream — this is the file content',
    },
  ];
  const [result] = await executeCatAgentTools(blocks, tools);
  assert.equal(result.id, 'use-1');
  assert.equal(result.status, 'ok', 'successful tool stays ok regardless of content text (KD-38 honesty)');
  assert.ok(result.content.startsWith('Error: 200 OK'), 'content preserved verbatim');
});

test('F153 Phase J AC-J2 CatAgent R1 P2 fix: thrown error → status=error', async () => {
  const blocks = [{ id: 'use-2', type: 'tool_use', name: 'broken_tool', input: {} }];
  const tools = [
    {
      name: 'broken_tool',
      schema: fakeSchema('broken_tool'),
      execute: async () => {
        throw new Error('upstream timeout');
      },
    },
  ];
  const [result] = await executeCatAgentTools(blocks, tools);
  assert.equal(result.status, 'error', 'thrown error → status=error');
  assert.ok(result.content.includes('upstream timeout'));
});

test('F153 Phase J AC-J2 CatAgent R1 P2 fix: unknown tool → status=error', async () => {
  const blocks = [{ id: 'use-3', type: 'tool_use', name: 'ghost_tool', input: {} }];
  const [result] = await executeCatAgentTools(blocks, []);
  assert.equal(result.status, 'error', 'unknown tool → status=error');
  assert.ok(result.content.includes('unknown tool'));
});

// fragile: source-string assertion, see PR #774 P2-2
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
