/**
 * Tool Classification Tests — F150 (#339)
 * classifyTool() correctly buckets tool_use events into native / mcp / skill.
 * Uses real provider output formats, not hand-written idealized strings.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('classifyTool', () => {
  /** Lazy import from built output (consistent with other API tests) */
  async function load() {
    return import('../dist/domains/cats/services/tool-usage/classify.js');
  }

  // --- Native tools (all providers use bare names) ---

  test('classifies native tools (Read, Write, Edit, Bash)', async () => {
    const { classifyTool } = await load();
    assert.deepStrictEqual(classifyTool('Read', undefined), {
      category: 'native',
      toolName: 'Read',
    });
    assert.deepStrictEqual(classifyTool('Edit', { file_path: '/foo' }), {
      category: 'native',
      toolName: 'Edit',
    });
    assert.deepStrictEqual(classifyTool('Bash', undefined), {
      category: 'native',
      toolName: 'Bash',
    });
  });

  // --- MCP tools: Claude Code format (mcp__{server}__{tool}) ---

  test('classifies Claude Code MCP tools (mcp__server__tool)', async () => {
    const { classifyTool } = await load();
    assert.deepStrictEqual(classifyTool('mcp__cat-cafe__cat_cafe_post_message', undefined), {
      category: 'mcp',
      toolName: 'mcp__cat-cafe__cat_cafe_post_message',
      mcpServer: 'cat-cafe',
    });
  });

  test('classifies Claude Code MCP tools with hyphenated server names', async () => {
    const { classifyTool } = await load();
    assert.deepStrictEqual(classifyTool('mcp__cat-cafe-memory__cat_cafe_search_evidence', undefined), {
      category: 'mcp',
      toolName: 'mcp__cat-cafe-memory__cat_cafe_search_evidence',
      mcpServer: 'cat-cafe-memory',
    });
  });

  // --- MCP tools: Codex format (mcp:{server}/{tool}) ---
  // Source: codex-event-transform.ts line 96

  test('classifies Codex MCP tools (mcp:server/tool)', async () => {
    const { classifyTool } = await load();
    assert.deepStrictEqual(classifyTool('mcp:cat-cafe/post_message', undefined), {
      category: 'mcp',
      toolName: 'mcp:cat-cafe/post_message',
      mcpServer: 'cat-cafe',
    });
  });

  test('classifies Codex MCP tools with hyphenated server names', async () => {
    const { classifyTool } = await load();
    assert.deepStrictEqual(classifyTool('mcp:cat-cafe-memory/search_evidence', { query: 'test' }), {
      category: 'mcp',
      toolName: 'mcp:cat-cafe-memory/search_evidence',
      mcpServer: 'cat-cafe-memory',
    });
  });

  // --- Skill tool ---

  test('classifies Skill tool and extracts skill name from toolInput', async () => {
    const { classifyTool } = await load();
    assert.deepStrictEqual(classifyTool('Skill', { skill: 'tdd', args: '--verbose' }), {
      category: 'skill',
      toolName: 'tdd',
    });
  });

  test('classifies Skill with missing skill name as "unknown"', async () => {
    const { classifyTool } = await load();
    assert.deepStrictEqual(classifyTool('Skill', {}), { category: 'skill', toolName: 'unknown' });
    assert.deepStrictEqual(classifyTool('Skill', undefined), { category: 'skill', toolName: 'unknown' });
  });

  // --- Edge cases ---

  test('handles unknown tool name as native', async () => {
    const { classifyTool } = await load();
    assert.deepStrictEqual(classifyTool('unknown', undefined), { category: 'native', toolName: 'unknown' });
  });

  test('handles mcp__ with no second separator', async () => {
    const { classifyTool } = await load();
    assert.deepStrictEqual(classifyTool('mcp__standalone', undefined), {
      category: 'mcp',
      toolName: 'mcp__standalone',
      mcpServer: 'standalone',
    });
  });

  test('handles mcp: with no slash separator', async () => {
    const { classifyTool } = await load();
    assert.deepStrictEqual(classifyTool('mcp:standalone', undefined), {
      category: 'mcp',
      toolName: 'mcp:standalone',
      mcpServer: 'standalone',
    });
  });
});
