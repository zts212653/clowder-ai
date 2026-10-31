import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { parseIntent, stripIntentTags, ROUTE_CONTROL_TAGS } = await import(
  '../dist/domains/cats/services/context/IntentParser.js'
);

describe('parseIntent', () => {
  it('explicit #ideate → ideate', () => {
    const r = parseIntent('@布偶 @缅因 #ideate 你们怎么看', 2);
    assert.equal(r.intent, 'ideate');
    assert.equal(r.explicit, true);
  });

  it('explicit #execute → execute', () => {
    const r = parseIntent('@布偶 @缅因 #execute 先布偶写再缅因审', 2);
    assert.equal(r.intent, 'execute');
    assert.equal(r.explicit, true);
  });

  it('auto-infers ideate for ≥2 cats', () => {
    const r = parseIntent('@布偶 @缅因 你们好', 2);
    assert.equal(r.intent, 'ideate');
    assert.equal(r.explicit, false);
  });

  it('auto-infers execute for 1 cat', () => {
    const r = parseIntent('@布偶 帮我看看代码', 1);
    assert.equal(r.intent, 'execute');
    assert.equal(r.explicit, false);
  });

  it('extracts #critique as promptTag', () => {
    const r = parseIntent('@布偶 #critique 这个方案有什么问题', 1);
    assert.deepEqual(r.promptTags, ['critique']);
  });

  it('#execute + #critique combination', () => {
    const r = parseIntent('@布偶 @缅因 #execute #critique 串行批评模式', 2);
    assert.equal(r.intent, 'execute');
    assert.equal(r.explicit, true);
    assert.deepEqual(r.promptTags, ['critique']);
  });

  it('single cat + #ideate is valid', () => {
    const r = parseIntent('@布偶 #ideate 独立思考', 1);
    assert.equal(r.intent, 'ideate');
    assert.equal(r.explicit, true);
  });

  it('case-insensitive tags', () => {
    const r = parseIntent('@布偶 #IDEATE #Critique 大写测试', 1);
    assert.equal(r.intent, 'ideate');
    assert.deepEqual(r.promptTags, ['critique']);
  });

  it('tag in middle of message', () => {
    const r = parseIntent('请 @布偶 用 #critique 的方式分析代码', 1);
    assert.equal(r.intent, 'execute');
    assert.deepEqual(r.promptTags, ['critique']);
  });

  it('no tags → empty promptTags', () => {
    const r = parseIntent('@布偶 帮我写代码', 1);
    assert.deepEqual(r.promptTags, []);
  });

  it('wakes custody recognition for an explicit time-bound deliverable', () => {
    const r = parseIntent('下周一下午 3 点前帮我准备两个方案，做完回来让我选', 1);
    assert.deepEqual(r.promptTags, ['skill:custody-recognition']);
  });

  it('wakes custody recognition for an implicit future obligation', () => {
    const r = parseIntent('别忘了下周把发布清单整理出来', 1);
    assert.deepEqual(r.promptTags, ['skill:custody-recognition']);
  });

  it('wakes custody recognition for a natural time-bound work introduction mixed with anxiety', () => {
    const r = parseIntent('@codex-astra 有个活儿，周四 F311 需要去演示，我现在好焦虑怎么办！', 1);
    assert.deepEqual(r.promptTags, ['skill:custody-recognition']);
  });

  it('wakes the owner policy for untimed development and Phase continuation', () => {
    for (const message of [
      '开始开发 F311',
      '继续 Phase B',
      '这个方案通过，开工吧',
      '我希望越快越好地开发完成 F311',
      '接着把这个阶段做完',
      'F311 已经批准，开始做吧',
      '完成 F311',
      '请完成 F311',
      '做完这个阶段',
      '把 Phase B 做完',
      '请把 Phase B 做完',
      '不用等方案通过了，开工吧',
      '别等批准了，开始开发 F311',
      '无需等确认，现在开工吧',
      '不用等了直接开始开发 F311',
      '@codex6-sol 开工吧',
      '@codex6-sol 完成 F311',
      '@codex6-sol 我希望越快越好地开发完成 F311',
      '@缅因猫 开始开发 F311',
      '@codex6-sol\n继续 Phase B',
      '@codex6-sol #execute 开始开发 F311',
    ]) {
      assert.deepEqual(parseIntent(message, 1).promptTags, ['skill:custody-recognition'], message);
    }
  });

  it('does not infer a development handoff from discussion, refusal, or quoted examples', () => {
    for (const message of [
      'F311 的方案还在讨论',
      '我们先讨论如何开发 F311',
      '如果这个方案通过，就开工吧',
      '等方案通过再开工吧',
      '不要开始开发 F311',
      '先别继续 Phase B',
      '“开始开发 F311”这句话只是测试样本',
      '> 继续 Phase B\n这里是在引用原话',
      '```text\n开始开发 F311\n```\n请分析这段话',
      '继续 Phase B 需要什么条件？',
      '他说开始开发 F311 只是举例，不是让你执行',
      '请分析 `开始开发 F311` 这句话',
      '什么时候开始开发 F311',
      '完成 F311 是这轮目标',
      '为什么开始开发 F311',
      '为何开始开发 F311',
      '不是让你开始开发 F311',
      '用户昨天说过开始开发 F311',
      '他说 开工吧',
      '文档写着我希望越快越好地开发完成 F311',
      '他说，开工吧',
      '用户昨天说过，开始开发 F311',
      '文档写着，我希望越快越好地开发完成 F311',
      '用户昨天说过 F311 已批准开始做吧',
      'F311',
    ]) {
      assert.deepEqual(parseIntent(message, 1).promptTags, [], message);
    }
  });

  it('keeps one deterministic wakeup on replay or alongside another prompt tag', () => {
    const source = '#critique 方案通过了，开始开发 F311';
    const first = parseIntent(source, 1);
    assert.deepEqual(first.promptTags, ['critique', 'skill:custody-recognition']);
    assert.deepEqual(parseIntent(source, 1), first);
  });

  it('can wake on a real instruction after a quoted example or separate refusal', () => {
    assert.deepEqual(parseIntent('“继续 Phase B”是旧说法。现在开始开发 F311', 1).promptTags, [
      'skill:custody-recognition',
    ]);
    assert.deepEqual(parseIntent('不要开发 F312。开始开发 F311', 1).promptTags, ['skill:custody-recognition']);
    assert.deepEqual(parseIntent('先别开发 F312，开始开发 F311', 1).promptTags, ['skill:custody-recognition']);
    assert.deepEqual(parseIntent('先讨论 F312，现在开始开发 F311', 1).promptTags, ['skill:custody-recognition']);
    assert.deepEqual(parseIntent('还等什么，开工吧', 1).promptTags, ['skill:custody-recognition']);
    assert.deepEqual(parseIntent('我们现在开始开发 F311', 1).promptTags, ['skill:custody-recognition']);
    assert.deepEqual(parseIntent('他说，开工吧。现在开工吧', 1).promptTags, ['skill:custody-recognition']);
  });

  it('does not treat venting or a one-turn request as durable custody', () => {
    assert.deepEqual(parseIntent('下周又要写汇报，想想就烦', 1).promptTags, []);
    assert.deepEqual(parseIntent('下周有个活儿，想到就烦', 1).promptTags, []);
    assert.deepEqual(parseIntent('帮我看看这段代码', 1).promptTags, []);
  });

  it('unknown tags are ignored', () => {
    const r = parseIntent('@布偶 #foobar #critique 测试', 1);
    assert.deepEqual(r.promptTags, ['critique']);
    // #foobar is not captured as intent or promptTag
  });
});

describe('stripIntentTags', () => {
  it('removes intent and prompt tags', () => {
    const result = stripIntentTags('@布偶 @缅因 #ideate #critique 你们好');
    assert.equal(result, '@布偶 @缅因 你们好');
  });

  it('preserves unknown hashtags', () => {
    const result = stripIntentTags('看看 #issue123 的问题 #execute');
    assert.ok(result.includes('#issue123'));
    assert.ok(!result.includes('#execute'));
  });

  it('collapses extra whitespace', () => {
    const result = stripIntentTags('hello #ideate world');
    assert.equal(result, 'hello world');
  });

  it('trims result', () => {
    const result = stripIntentTags('#ideate 开始');
    assert.equal(result, '开始');
  });
});

describe('ROUTE_CONTROL_TAGS', () => {
  it('exports every tag that route-line detection must accept', () => {
    assert.deepEqual([...ROUTE_CONTROL_TAGS].sort(), ['critique', 'execute', 'ideate']);

    for (const tag of ROUTE_CONTROL_TAGS) {
      assert.equal(stripIntentTags(`#${tag} body`), 'body', `#${tag} should be stripped by IntentParser`);
    }
  });
});
