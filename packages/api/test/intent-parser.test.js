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
