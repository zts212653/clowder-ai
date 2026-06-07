import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

function readRepoFile(relativePath) {
  return readFileSync(new URL(`../../../../${relativePath}`, import.meta.url), 'utf8');
}

describe('F223 Phase B2 rich-messaging surface contract', () => {
  it('keeps skill trigger, MCP description, and F192 predicate aligned for long structured reports', () => {
    const skill = readRepoFile('cat-cafe-skills/rich-messaging/SKILL.md');
    const wakeupIndex = readRepoFile('cat-cafe-skills/refs/capability-wakeup-index.md');
    const callbackTools = readRepoFile('packages/mcp-server/src/tools/callback-tools.ts');
    const classifyTest = readRepoFile('packages/api/test/harness-eval/eval-capability-wakeup-classify.test.js');

    assert.match(skill, /想发一堆文字/);
    assert.match(skill, /日志/);
    assert.match(skill, /步骤/);
    assert.match(skill, /长结构化汇报/);
    assert.match(skill, /cat_cafe_create_rich_block/);

    assert.match(wakeupIndex, /想发一堆文字[\s\S]*日志[\s\S]*步骤/);
    assert.match(wakeupIndex, /cat_cafe_create_rich_block/);

    assert.match(callbackTools, /long structured replies\/reports/i);
    assert.match(callbackTools, /F192 rich-messaging wakeup/i);

    assert.match(classifyTest, /rich-messaging-long-structured-text/);
    assert.match(classifyTest, /multi_msg_text_volume_threshold/);
    assert.match(classifyTest, /minStructuredSignals/);
  });
});
