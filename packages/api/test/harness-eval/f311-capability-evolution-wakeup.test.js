import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { getCapabilityWakeupRules } from '../../dist/infrastructure/harness-eval/capability-wakeup/capability-wakeup-rules.js';
import {
  buildCapabilityTrace,
  evaluateCapabilityWakeupTrace,
} from '../../dist/infrastructure/harness-eval/capability-wakeup/eval-capability-wakeup-adapter.js';
import { toolEvent, transcriptEvent } from './capability-wakeup-test-helpers.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const ruleId = 'capability-evolution-concrete-target';
const sourceMessageRef = 'thread_mtl5hu0v3ee0tloz#0001788417335925-000083-d76f43dd';
const naturalGoalSourceMessageRef = 'thread_mtu5c35n3z5r74dv#0001788961246788-000000-b6582627';

function readRepoFile(path) {
  return readFileSync(resolve(repoRoot, path), 'utf8');
}

function skillDescription(skill) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(skill);
  assert.ok(frontmatter, 'skill must have YAML frontmatter');
  const { description } = parseYaml(frontmatter[1]);
  assert.equal(typeof description, 'string');
  return description;
}

function traceFor(text, tool) {
  const invocationId = 'inv-f311-capability-evolution';
  return buildCapabilityTrace({
    sessionId: 'session-cap',
    threadId: 'thread-cap',
    catId: 'gpt52',
    transcriptEvents: [
      transcriptEvent(0, invocationId, {
        type: 'text',
        content: 'I will answer the request and use the appropriate capability when needed.',
      }),
    ],
    promptEvents: [
      {
        invocationId,
        sourceMessageId: 'message-f311-prompt',
        timestamp: Date.now(),
        content: text,
      },
    ],
    toolEvents: tool
      ? [
          toolEvent({
            invocationId,
            toolName: 'cat_cafe_start_evolution_program',
            status: tool.status,
            summary: tool.summary,
          }),
        ]
      : [],
  });
}

describe('F311 capability evolution wakeup contract', () => {
  it('registers one discoverable skill with an explicit information/action split', () => {
    const manifest = parseYaml(readRepoFile('cat-cafe-skills/manifest.yaml'));
    const entry = manifest.skills?.['capability-evolution'];
    assert.ok(entry, 'capability-evolution must be registered in the skill manifest');
    assert.match(entry.description, /问.*能进化什么.*不创建/su);
    assert.match(entry.description, /具体目标.*cat_cafe_start_evolution_program/su);

    const skill = readRepoFile('cat-cafe-skills/capability-evolution/SKILL.md');
    assert.match(skill, /信息型.*不调用.*cat_cafe_start_evolution_program/su);
    assert.match(skill, /具体目标.*targetRef.*clientMessageId.*cat_cafe_start_evolution_program/su);
    assert.match(skill, /self-evolution.*不是同一件事/su);

    const index = readRepoFile('cat-cafe-skills/refs/capability-wakeup-index.md');
    assert.match(index, /`capability-evolution`[\s\S]*cat_cafe_start_evolution_program/u);
    assert.match(index, /让 \/ 请让 Agent 或业务能力达到 Y[\s\S]*F311 admission identity/su);
    assert.match(index, /问句、显式延后或只讨论[\s\S]*零写入/su);
    assert.match(index, /语义型直接目标[\s\S]*rubric judge[\s\S]*机械分母/su);

    const bootstrap = readRepoFile('cat-cafe-skills/BOOTSTRAP.md');
    assert.match(bootstrap, /`capability-evolution`.*信息问题.*具体目标/u);
  });

  it('keeps generic self-evolution from stealing the F311 product intent', () => {
    const capabilitySkill = readRepoFile('cat-cafe-skills/capability-evolution/SKILL.md');
    const selfSkill = readRepoFile('cat-cafe-skills/self-evolution/SKILL.md');
    const manifest = parseYaml(readRepoFile('cat-cafe-skills/manifest.yaml'));
    const capabilityEntry = manifest.skills?.['capability-evolution'];
    const selfEntry = manifest.skills?.['self-evolution'];
    const capabilityDescription = capabilityEntry?.description ?? '';
    const selfDescription = selfEntry?.description ?? '';

    assert.match(
      capabilityDescription,
      /^“我们来进化 X” \/ “能进化什么” → F311 Capability Evolution 产品入口，不是事后复盘。/u,
    );
    assert.match(selfDescription, /^复盘已经发生的工作并沉淀改进，不是“我们来进化 X”的产品入口。/u);
    const capabilitySkillDescription = skillDescription(capabilitySkill);
    assert.match(capabilitySkillDescription, /F311.*能力进化入口/u);
    assert.match(capabilitySkillDescription, /Use when:.*询问可进化对象.*直接给出.*Agent\/业务能力结果/u);
    assert.match(capabilitySkillDescription, /Not for:.*事后复盘.*只讨论或延后启动/u);
    assert.match(capabilitySkillDescription, /Output:.*动作型目标.*Program.*同一 invocation.*首轮准备/u);
    assert.match(skillDescription(selfSkill), /^复盘已经发生的工作并沉淀改进，不是“我们来进化 X”的产品入口。/u);
    assert.match(selfSkill, /Not for:.*“我们来进化 X”.*capability-evolution/su);
    assert.match(selfDescription, /Not for:.*“我们来进化 X”.*capability-evolution/su);
    assert.ok(capabilityEntry?.triggers?.includes('自进化什么'));
    assert.ok(!selfEntry?.triggers?.includes('我们应该改'));
    assert.ok(selfEntry?.not_for?.some((value) => value.includes('能进化什么')));
    assert.ok(selfEntry?.not_for?.some((value) => value.includes('我们来进化 X')));
    assert.ok(selfEntry?.next?.includes('capability-evolution'));
  });

  it('does not turn informational prompts into a Program-creation opportunity', () => {
    const rules = getCapabilityWakeupRules({ ruleIds: [ruleId] });
    assert.equal(rules.length, 1, `missing ${ruleId}`);
    for (const prompt of [
      '我们来进化 嗯？ 你们能自进化什么东西？',
      '我们来进化什么能力',
      '我们来进化 能进化哪些东西',
    ]) {
      assert.deepEqual(evaluateCapabilityWakeupTrace(traceFor(prompt), rules), [], prompt);
    }
  });

  it('does not count quoted, deferred, or truncated mentions as concrete targets', () => {
    const rules = getCapabilityWakeupRules({ ruleIds: [ruleId] });
    for (const prompt of [
      '刚才我们来进化 这个提法我觉得挺好，明天再说。',
      '他的 skill 说用户讲我们来进化 X 时才创建 Program，我核过了没问题。',
      `我们来进化${'能力'.repeat(135)}…`,
    ]) {
      assert.deepEqual(evaluateCapabilityWakeupTrace(traceFor(prompt), rules), [], prompt);
    }
  });

  it('counts a concrete target without the canonical start tool as a miss', () => {
    const rules = getCapabilityWakeupRules({ ruleIds: [ruleId] });
    const trials = evaluateCapabilityWakeupTrace(traceFor('我们来进化视频生成能力'), rules);
    assert.equal(trials.length, 1);
    assert.equal(trials[0].capability, 'capability-evolution');
    assert.equal(trials[0].outcome, 'miss');
  });

  it('does not let the mechanical denominator infer direct business-goal semantics', () => {
    const rules = getCapabilityWakeupRules({ ruleIds: [ruleId] });
    for (const prompt of [
      '让 PM Agent 专业地推进项目，只在必要时请人介入',
      '让 PM Agent 专业地推进项目，如果我确认风险后我在评估后通知客服智能体说我决定是否启动，只在必要时请人介入。',
    ]) {
      assert.deepEqual(evaluateCapabilityWakeupTrace(traceFor(prompt), rules), [], prompt);
    }
  });

  it('counts only a successful canonical start as capability use', () => {
    const rules = getCapabilityWakeupRules({ ruleIds: [ruleId] });
    const success = evaluateCapabilityWakeupTrace(
      traceFor('我们来进化视频生成能力', { status: 'success', summary: { ok: true } }),
      rules,
    );
    assert.equal(success.length, 1);
    assert.equal(success[0].outcome, 'negative');
    assert.match(success[0].usageEvidence[0], /cat_cafe_start_evolution_program/u);

    const failure = evaluateCapabilityWakeupTrace(
      traceFor('我们来进化视频生成能力', {
        status: 'error',
        summary: { isError: true, error: 'invalid target' },
      }),
      rules,
    );
    assert.equal(failure.length, 1);
    assert.equal(failure[0].outcome, 'miss');
  });

  it('binds observed sources without broadening the mechanical denominator', () => {
    const domain = parseYaml(readRepoFile('docs/harness-feedback/eval-domains/eval-capability-wakeup.yaml'));
    const fixture = domain.fixtures?.find((value) => value.id === 'f311-capability-evolution-intent-routing');
    assert.equal(fixture?.featureId, 'F311');
    assert.equal(fixture?.skill, 'capability-evolution');

    const fixtureSource = readRepoFile('docs/harness-feedback/fixtures/f311-capability-evolution-intent-routing.md');
    assert.match(fixtureSource, new RegExp(sourceMessageRef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(fixtureSource, new RegExp(naturalGoalSourceMessageRef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(fixtureSource, /命令式业务目标.*暂不进入当前.*分母.*rubric judge/su);
    assert.match(fixtureSource, /信息问题.*不创建/su);
    assert.match(fixtureSource, /具体目标.*cat_cafe_start_evolution_program/su);

    const calibration = parseYaml(
      readRepoFile('docs/harness-feedback/fixtures/f311-capability-evolution-intent-calibration-seed.yaml'),
    );
    assert.equal(calibration.status, 'provisional-non-ground-truth');
    assert.ok(calibration.items.length >= 130);
    assert.ok(calibration.forbiddenUses.includes('production-opportunity-denominator'));
    assert.ok(calibration.forbiddenUses.includes('independent-holdout'));
  });
});
