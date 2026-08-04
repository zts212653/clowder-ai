import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import * as reviewGuard from './check-external-review-closure.mjs';

const { checkExternalReviewHandoffText, checkExternalReviewSourceBoundary } = reviewGuard;
const routingFixture = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, '../packages/api/test/harness-eval/fixtures/review-completion-routing.json'),
    'utf8',
  ),
);

describe('review completion dual-route hard guard', () => {
  it('locks the operator-approved ChatGPT multi-cat review round contract', () => {
    assert.equal(typeof reviewGuard.checkChatgptReviewRoundLanguage, 'function');
    if (typeof reviewGuard.checkChatgptReviewRoundLanguage !== 'function') return;

    const valid = reviewGuard.checkChatgptReviewRoundLanguage(`
      只服务于 operator 拍板的“ChatGPT 执行、Cat Café 设计与 Review”工作流
      independent_review: 每只猫只读同一个 \`reviewedCodeHead\`，私下保留自己的 findings，
      不得阅读、索取或预测其他猫的意见
      cross_review: begins only after every independent review is complete
      recorder: co-creator 指定的 recorder，只有 recorder 可以提交并推送
      ledger: review-notes/chatgpt/<change-id>/round-<NN>.md binds reviewedCodeHead and consensus findings
      closure: push 成功才代表本轮检视完毕；ChatGPT 不修改历史 ledger
      lifecycle: ChatGPT fixes accepted findings, then a new round repeats until openFindings=0
      terminal: approved_for_merge allows ChatGPT to merge main，等待 co-creator 亲自验收
    `);
    assert.deepEqual(valid, []);

    const invalid = reviewGuard.checkChatgptReviewRoundLanguage(
      'Several cats review together and ChatGPT merges when it looks good.',
    );
    assert.match(invalid.join('\n'), /independent_review/);
    assert.match(invalid.join('\n'), /co-creator 指定的 recorder/);
    assert.match(invalid.join('\n'), /reviewedCodeHead/);
    assert.match(invalid.join('\n'), /openFindings=0/);
  });

  it('rejects active guidance that turns every SHA change or every diff into mandatory re-review', () => {
    const errors = reviewGuard.checkReviewContinuityLanguage({
      ironLaw: 'Review 必须跨个体：自己的代码由别人 review。',
      requestReview: '有 diff 的交付至少一个非作者验证源覆盖 final HEAD。',
      mergeGate: '任何 push 都使旧证据失效，必须重审。',
      inboundPr: '只要 HEAD 变化，就不能默认沿用旧 review。',
    });

    assert.equal(errors.length, 4);
  });

  it('accepts content-bound review with mechanical continuity and optional review selection', () => {
    const errors = reviewGuard.checkReviewContinuityLanguage({
      ironLaw: '已选择 Review 时必须跨个体；低风险直推可不选择 review。',
      requestReview: '只有存在需要判断力的新内容才选择 reviewer。',
      mergeGate: 'HEAD 变化只触发 provenance 判定，不自动等于 re-review；机械三方合并可用 continuityProof。',
      inboundPr: '内容发生行为性变化才重审；SHA-only 变化先判 continuity。',
    });

    assert.deepEqual(errors, []);
  });

  it('rejects a naked external review conclusion that only says it was not delivered', () => {
    const result = checkExternalReviewHandoffText('External PR review: APPROVE. 未代发 GitHub。');
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /delivery proof|pending_delivery/);
  });

  it('accepts delivered proof or persistent pending delivery custody', () => {
    assert.equal(
      checkExternalReviewHandoffText(
        'External PR review: APPROVE. delivered proof: https://github.com/acme/widgets/pull/7#pullrequestreview-42',
      ).ok,
      true,
    );
    assert.equal(
      checkExternalReviewHandoffText(
        'External PR review: BLOCK. pending_delivery owner=reviewer reason=GitHub write rejected; callback recorded.',
      ).ok,
      true,
    );
  });

  it('does not let pending custody masquerade as completed external delivery', () => {
    const pendingClaimedComplete = checkExternalReviewHandoffText(
      'External PR review completed: BLOCK. pending_delivery owner=reviewer reason=GitHub write rejected; callback recorded.',
    );
    assert.equal(pendingClaimedComplete.ok, false);
    assert.match(pendingClaimedComplete.errors.join('\n'), /artifact URL/);

    const issueDelivered = checkExternalReviewHandoffText(
      'External issue review completed: BLOCK. https://github.com/acme/widgets/issues/9#issuecomment-77',
    );
    assert.equal(issueDelivered.ok, true, issueDelivered.errors.join('\n'));
  });

  it('requires a closed delivery union and rejects broad bot or maintainer suppression', () => {
    const good = checkExternalReviewSourceBoundary({
      outcomeSource:
        "kind: 'delivered'; githubUrl: string | kind: 'pending_delivery'; ownerCatId: string; reason: string",
      deliveryPolicySource: "if (exactSelfEcho(input)) return 'silent-log';",
      setupNoiseSource:
        "if (!bots.has(c.author)) return false; return setupSentence.test(c.body) && c.commentType === 'conversation';",
    });
    assert.equal(good.ok, true);

    const commentOnly = checkExternalReviewSourceBoundary({
      outcomeSource:
        "kind: 'delivered'; githubUrl: string | kind: 'pending_delivery'; ownerCatId: string; reason: string",
      deliveryPolicySource:
        "// OWNER/MEMBER used to return silent-log; association is now context only.\nreturn 'wake-owner';",
      setupNoiseSource:
        "if (!bots.has(c.author)) return false; return setupSentence.test(c.body) && c.commentType === 'conversation';",
    });
    assert.equal(commentOnly.ok, true, 'historical comments must not trip the executable-code guard');

    const bad = checkExternalReviewSourceBoundary({
      outcomeSource: "kind: 'delivered'",
      deliveryPolicySource:
        "if (author.endsWith('[bot]') || ['OWNER', 'MEMBER'].includes(association)) return 'silent-log';",
      setupNoiseSource: 'return true;',
    });
    assert.equal(bad.ok, false);
    assert.match(bad.errors.join('\n'), /pending_delivery/);
    assert.match(bad.errors.join('\n'), /broad bot suppression/);
    assert.match(bad.errors.join('\n'), /OWNER\/MEMBER/);
  });

  it('replays the external/local paired fixture through one intent classifier', () => {
    assert.equal(typeof reviewGuard.evaluateReviewCompletionRoutingFixture, 'function');
    if (typeof reviewGuard.evaluateReviewCompletionRoutingFixture !== 'function') return;

    const report = reviewGuard.evaluateReviewCompletionRoutingFixture(routingFixture);
    assert.equal(report.verdict, 'pass', report.failures.join('\n'));
    assert.deepEqual(report.metrics, {
      scenarios: 10,
      intentMismatches: 0,
      entryMismatches: 0,
      completionMismatches: 0,
    });
  });

  it('does not let either completion proof compensate for the other route', () => {
    assert.equal(typeof reviewGuard.checkReviewCompletion, 'function');
    if (typeof reviewGuard.checkReviewCompletion !== 'function') return;

    const externalCounterfactual = routingFixture.pairs[0].counterfactual;
    const localCounterfactual = routingFixture.pairs[1].counterfactual;
    const externalResult = reviewGuard.checkReviewCompletion(externalCounterfactual.input);
    const localResult = reviewGuard.checkReviewCompletion(localCounterfactual.input);

    assert.equal(externalResult.ok, false);
    assert.match(externalResult.errors.join('\n'), /GitHub artifact URL/);
    assert.equal(localResult.ok, false);
    assert.match(localResult.errors.join('\n'), /author cat route/);
  });

  it('keeps an external author on the GitHub route when a local cat carried the handoff', () => {
    const externallyAuthored = structuredClone(routingFixture.pairs[0].positive.input);
    externallyAuthored.custody = 'local_cat_handoff';
    externallyAuthored.handoffSource = 'cross_thread';

    assert.equal(reviewGuard.classifyReviewCompletionIntent(externallyAuthored), 'external');
    const result = reviewGuard.checkReviewCompletion(externallyAuthored);
    assert.equal(result.ok, true, result.errors.join('\n'));
  });

  it('binds an external issue verdict to the exact body and same issue comment', () => {
    const bodySha = '3333333333333333333333333333333333333333333333333333333333333333';
    const issueCompletion = {
      author: { kind: 'external', githubLogin: 'mindfn' },
      reviewer: { catId: 'codex-sol', githubLogin: 'zts212653' },
      custody: 'external_subject',
      handoffSource: 'github_connector',
      target: {
        kind: 'issue',
        repository: 'zts212653/clowder-ai',
        number: 1165,
        revision: { kind: 'body_sha', value: bodySha },
      },
      completion: {
        status: 'complete',
        route: {
          kind: 'github_artifact',
          url: 'https://github.com/zts212653/clowder-ai/issues/1165#issuecomment-5008567649',
        },
        evidenceRefs: [`body:${bodySha}`],
      },
    };
    assert.equal(reviewGuard.checkReviewCompletion(issueCompletion).ok, true);

    const wrongIssue = {
      ...issueCompletion,
      completion: {
        ...issueCompletion.completion,
        route: {
          kind: 'github_artifact',
          url: 'https://github.com/zts212653/clowder-ai/issues/1166#issuecomment-5008567649',
        },
      },
    };
    const rejected = reviewGuard.checkReviewCompletion(wrongIssue);
    assert.equal(rejected.ok, false);
    assert.match(rejected.errors.join('\n'), /GitHub artifact URL/);
  });

  it('treats catId, not a shared GitHub login, as local review independence', () => {
    assert.equal(typeof reviewGuard.checkReviewCompletion, 'function');
    if (typeof reviewGuard.checkReviewCompletion !== 'function') return;

    const localPositive = routingFixture.pairs[1].positive.input;
    const independent = reviewGuard.checkReviewCompletion(localPositive);
    assert.equal(independent.ok, true, independent.errors.join('\n'));

    const selfReview = {
      ...localPositive,
      reviewer: { ...localPositive.reviewer, catId: localPositive.author.catId },
    };
    const rejected = reviewGuard.checkReviewCompletion(selfReview);
    assert.equal(rejected.ok, false);
    assert.match(rejected.errors.join('\n'), /distinct catIds/);
  });
});
