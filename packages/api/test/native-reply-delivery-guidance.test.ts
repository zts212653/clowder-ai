import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadL5McpToolsIndex } from '../src/domains/cats/services/context/prompt-template-loader.js';
import { getMcpToolsSection } from '../src/domains/cats/services/context/SystemPromptBuilder.js';

test('native and non-native MCP prompt planes distinguish final replies from intermediate callback posts', () => {
  for (const text of [loadL5McpToolsIndex(), getMcpToolsSection()]) {
    assert.ok(text.includes('最终答复直接输出一次'));
    assert.ok(text.includes('中途进度/主动通知'));
    assert.ok(text.includes('明确要求 callback 交付的外部客户端'));
    assert.ok(text.includes('cat_cafe_cross_post_message'));
    assert.ok(text.includes('ALL_TOOLS.filter'));
    assert.ok(text.includes("t.description?.startsWith('MCP tool: ' + canonical + '. ')"));
    assert.ok(text.includes('仅唯一命中'));
    assert.ok(text.includes('零条或多条'));
  }
});
