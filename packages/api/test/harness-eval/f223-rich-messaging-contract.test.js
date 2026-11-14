import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { parse } from 'yaml';

function readRepoFile(relativePath) {
  return readFileSync(new URL(`../../../../${relativePath}`, import.meta.url), 'utf8');
}

function readRichBlockDescription() {
  const tools = readRepoFile('packages/mcp-server/src/tools/callback-tools.ts');
  const declaration = tools.match(
    /name:\s*['"]cat_cafe_create_rich_block['"],\s*description:([\s\S]*?)\n\s*inputSchema:/,
  );
  assert.ok(declaration, 'the named rich-block tool must declare its description before its schema');
  return declaration[1];
}

describe('F223 Phase B2 rich-messaging surface contract', () => {
  it('keeps skill trigger, MCP description, and F192 predicate aligned for long structured reports', () => {
    const skill = readRepoFile('cat-cafe-skills/rich-messaging/SKILL.md');
    const wakeupIndex = readRepoFile('cat-cafe-skills/refs/capability-wakeup-index.md');
    const description = readRichBlockDescription();
    const classifyTest = readRepoFile('packages/api/test/harness-eval/eval-capability-wakeup-classify.test.js');

    assert.match(skill, /想发一堆文字/);
    assert.match(skill, /日志/);
    assert.match(skill, /步骤/);
    assert.match(skill, /长结构化汇报/);
    assert.match(skill, /cat_cafe_create_rich_block/);

    assert.match(wakeupIndex, /想发一堆文字[\s\S]*日志[\s\S]*步骤/);
    assert.match(wakeupIndex, /cat_cafe_create_rich_block/);

    assert.match(description, /long structured replies\/reports/i);
    assert.match(description, /F192 rich-messaging wakeup/i);

    assert.match(classifyTest, /rich-messaging-long-structured-text/);
    assert.match(classifyTest, /multi_msg_text_volume_threshold/);
    assert.match(classifyTest, /minStructuredSignals/);
  });

  it('keeps visible-in-Chat delivery intent aligned across L0, skill, manifest, MCP, and F192', () => {
    const l0 = readRepoFile('assets/prompt-templates/l6-capability-wakeup.md');
    const skill = readRepoFile('cat-cafe-skills/rich-messaging/SKILL.md');
    const manifest = parse(readRepoFile('cat-cafe-skills/manifest.yaml')).skills['rich-messaging'];
    const description = readRichBlockDescription();
    const wakeupRules = readRepoFile(
      'packages/api/src/infrastructure/harness-eval/capability-wakeup/capability-wakeup-rules.ts',
    );

    assert.match(l0, /Chat[^\n]*rich-messaging[^\n]*富文本/);
    assert.match(skill, /不要求用户说.*富文本/);
    assert.match(skill, /html_widget[\s\S]*media_gallery[\s\S]*browser-preview/);
    assert.ok(manifest.triggers.some((trigger) => /画个 HTML/.test(trigger)));
    assert.ok(manifest.triggers.includes('html_widget'));
    assert.match(description, /does not need to say.*rich text/i);
    for (const route of ['html_widget', 'media_gallery', 'browser-preview', 'cat_cafe_work', 'publish-reference']) {
      assert.ok(description.includes(route), `rich-block delivery must explain ${route} in its own description`);
    }
    assert.match(wakeupRules, /rich-messaging-visible-artifact-request/);
  });
});
