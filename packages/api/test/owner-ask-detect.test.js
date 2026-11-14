import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getCoCreatorConfig } from '../dist/config/cat-config-loader.js';
import {
  detectUnaddressedOwnerAsk,
  opensOwnerDecision,
} from '../dist/domains/cats/services/agents/routing/owner-ask-detect.js';

const ask = (text, extra = {}) => detectUnaddressedOwnerAsk({ text, routedToCat: false, ...extra });

describe('detectUnaddressedOwnerAsk: a cat waits for the owner without a mention', () => {
  it('finds a request that waits for the owner to nod', () => {
    assert.equal(ask('两版都画好了。\n\n你点头我就交给小太阳开工。'), 'after');
  });

  it('finds a request still waiting for one reply', () => {
    assert.equal(ask('侧栏标题改成一行还是保持原样，还在等你回一句。'), 'wait');
  });

  it('finds a request for the owner to restart', () => {
    assert.equal(ask('还剩一步：要你重启一次，这些改动才会进正式环境。'), 'need');
    assert.equal(ask('你方便的时候重启一次就行。'), 'owner_restart');
  });

  it('finds a wait that names the owner', () => {
    assert.equal(ask('L6 第 1 步仍在等co-creator，不动。'), 'wait_name');
    assert.equal(ask(`第一步照旧，等 ${getCoCreatorConfig().name} 回三件事。`), 'wait');
    assert.equal(ask(`这一步还在等 ${getCoCreatorConfig().name}，先不动。`), 'wait_name');
  });

  it('finds a decision the owner has not given yet', () => {
    assert.equal(ask('默认分支先不改，你还没定。'), 'not_yet');
  });

  it('reads only the final paragraph and ignores the signature', () => {
    assert.equal(ask('等你拍板的事已经处理完了。\n\n下面是测试结果，全部通过。\n\n[宪宪/Opus 5.5🐾]'), null);
    assert.equal(ask('测试全部通过。\n\n你点头我就合入。\n\n[宪宪/Opus 5.5🐾]'), 'after');
  });

  it('keeps a negation in another clause from hiding the ask', () => {
    assert.equal(ask('默认分支先不改，等你定了再说。'), 'wait');
  });
});

describe('detectUnaddressedOwnerAsk: wording that is not an owner ask', () => {
  it('ignores a negated request', () => {
    assert.equal(ask('这条不需要你拍板，等实拍回来我接着推。'), null);
    assert.equal(ask('合入后直接发布，不再重复请你确认。'), null);
  });

  it('ignores an affectionate sign-off', () => {
    assert.equal(ask('（蹲在门口等你回来，尾巴一甩一甩）'), null);
  });

  it('ignores a restart that already happened', () => {
    assert.equal(ask('你重启以后，这两样已经生效了。'), null);
  });

  it('ignores a pause acknowledgement the owner asked for', () => {
    assert.equal(ask('进度已保存，等待co-creator明确通知重启完成后再继续。'), null);
  });

  it('ignores a later moment and a conditional', () => {
    assert.equal(ask('等你看完这篇论文想改下一版时，我就按新形式重做。'), null);
    assert.equal(ask('以后有要你选的东西，我会带图来喊你。'), null);
  });

  it('ignores a cat delegating the question to another cat', () => {
    assert.equal(ask('整理好两张母图后，请直接请co-creator拍板确认。'), null);
  });

  it('ignores quoted wording', () => {
    assert.equal(ask('他原话是「等你拍板再说」，这件已经定了。'), null);
  });

  it('leaves a message routed to a cat with that cat', () => {
    assert.equal(ask('@codex-astra\n等co-creator点头之后，请把三样接进样机。', { routedToCat: true }), null);
  });
});

describe('detectUnaddressedOwnerAsk: census false positives found in review', () => {
  it('ignores a bare wait for the owner that continues into a later moment', () => {
    assert.equal(ask('猫咖这分工很好：等co-creator忙完想歇会儿的时候，你一伸手就有一只烁烁。'), null);
  });

  it('ignores a nod or confirmation that already happened', () => {
    assert.equal(ask('这次是你确认以后才交给小太阳的，原因我也告诉他了。'), null);
    assert.equal(ask('成员配置页：你点头后，设计规范和北极星都更新了，已经派给小太阳开工。'), null);
  });

  it('ignores wording that names a later decision rather than asking for one', () => {
    assert.equal(ask('这条不用你做什么。等那边报回代价，需要你拍板的地方他们会带着账来找你。'), null);
    assert.equal(ask('有新原因，或需要你决定时再报。'), null);
    assert.equal(ask('有要你选的东西，我会带图来喊你。'), null);
    assert.equal(ask('以后的汇总只写大家一致的、还有分歧的、要你定的。'), null);
  });

  it('still finds a pending decision phrased with the same words', () => {
    assert.equal(ask('需要你确认的是：先做 A 还是先做 B。'), 'need');
    assert.equal(ask('你点头我就交给小太阳开工。'), 'after');
  });

  it('leaves the text alone when this turn already opened a decision for the owner', () => {
    assert.equal(ask('我开了一张执行线程的提议卡，请你批准。', { openedOwnerDecision: true }), null);
    assert.equal(ask('', { openedOwnerDecision: true, blocks: [{ kind: 'interactive' }] }), 'card');
  });
});

describe('opensOwnerDecision', () => {
  it("recognises the tools that put a decision in the owner's pending list", () => {
    assert.equal(opensOwnerDecision('mcp__cat-cafe-collab__cat_cafe_propose_thread', {}), true);
    assert.equal(opensOwnerDecision('cat_cafe_register_scheduled_task', {}), true);
    assert.equal(
      opensOwnerDecision('cat_cafe_create_rich_block', { awaitResponseV1: { allowTextResponse: true } }),
      true,
    );
    assert.equal(opensOwnerDecision('cat_cafe_create_rich_block', '{"awaitResponseV1":{}}'), true);
    assert.equal(opensOwnerDecision('cat_cafe_cross_post_message', { effectClass: 'assign_work' }), true);
  });

  it('does not count ordinary tools or a card without a registered decision', () => {
    assert.equal(opensOwnerDecision('cat_cafe_create_rich_block', { block: { kind: 'interactive' } }), false);
    assert.equal(opensOwnerDecision('cat_cafe_cross_post_message', { effectClass: 'coordinate' }), false);
    assert.equal(opensOwnerDecision('cat_cafe_hold_ball', {}), false);
    assert.equal(opensOwnerDecision('Bash', { command: 'ls' }), false);
  });
});

describe('detectUnaddressedOwnerAsk: interactive cards', () => {
  it('treats an interactive card as an owner ask, since only a person can click it', () => {
    assert.equal(ask('', { blocks: [{ kind: 'interactive' }] }), 'card');
    assert.equal(ask('进度如下。', { routedToCat: true, blocks: [{ kind: 'card' }, { kind: 'interactive' }] }), 'card');
  });

  it('does not treat other rich blocks as an ask', () => {
    assert.equal(ask('进度如下。', { blocks: [{ kind: 'card' }, { kind: 'checklist' }] }), null);
  });
});
