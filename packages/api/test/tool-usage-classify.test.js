/**
 * Tool Classification Tests — F142
 * classifyTool() correctly buckets tool_use events into native / mcp / skill.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('classifyTool', () => {
  /** Lazy import from built output (consistent with other API tests) */
  async function load() {
    return import('../dist/domains/cats/services/tool-usage/classify.js');
  }

  test('classifies native tools', async () => {
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

  test('classifies MCP tools and extracts server name', async () => {
    const { classifyTool } = await load();
    assert.deepStrictEqual(classifyTool('mcp__cat-cafe__cat_cafe_post_message', undefined), {
      category: 'mcp',
      toolName: 'mcp__cat-cafe__cat_cafe_post_message',
      mcpServer: 'cat-cafe',
    });
  });

  test('classifies MCP tools with hyphenated server names', async () => {
    const { classifyTool } = await load();
    assert.deepStrictEqual(classifyTool('mcp__cat-cafe-memory__cat_cafe_search_evidence', undefined), {
      category: 'mcp',
      toolName: 'mcp__cat-cafe-memory__cat_cafe_search_evidence',
      mcpServer: 'cat-cafe-memory',
    });
  });

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

  test('handles edge cases', async () => {
    const { classifyTool } = await load();
    // unknown tool → native
    assert.deepStrictEqual(classifyTool('unknown', undefined), { category: 'native', toolName: 'unknown' });
    // MCP with no second separator
    assert.deepStrictEqual(classifyTool('mcp__standalone', undefined), {
      category: 'mcp',
      toolName: 'mcp__standalone',
      mcpServer: 'standalone',
    });
  });
});
