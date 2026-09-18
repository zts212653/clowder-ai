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

  it('keeps visible-in-Chat delivery intent aligned across the session hook, skill, manifest, MCP, and F192', () => {
    const sessionHook = readRepoFile('assets/prompt-hooks/l6-能力唤醒指南/l6-capability-wakeup.md');
    const skill = readRepoFile('cat-cafe-skills/rich-messaging/SKILL.md');
    const manifest = readRepoFile('cat-cafe-skills/manifest.yaml');
    const callbackTools = readRepoFile('packages/mcp-server/src/tools/callback-tools.ts');
    const wakeupRules = readRepoFile(
      'packages/api/src/infrastructure/harness-eval/capability-wakeup/capability-wakeup-rules.ts',
    );

    assert.match(sessionHook, /Chat[^\n]*rich-messaging[^\n]*富文本/);
    assert.match(skill, /不要求用户说.*富文本/);
    assert.match(skill, /html_widget[\s\S]*media_gallery[\s\S]*browser-preview/);
    assert.match(manifest, /rich-messaging:[\s\S]{0,1600}画个 HTML/);
    assert.match(manifest, /rich-messaging:[\s\S]{0,1600}html_widget/);
    assert.match(callbackTools, /does not need to say.*rich text/i);
    assert.match(callbackTools, /html_widget[\s\S]{0,500}media_gallery[\s\S]{0,500}browser-preview/);
    assert.match(wakeupRules, /rich-messaging-visible-artifact-request/);
  });
});
