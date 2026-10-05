import assert from 'node:assert/strict';
import { test } from 'node:test';
import '../helpers/setup-cat-registry.js';

const { MessageStore } = await import('../../dist/domains/cats/services/stores/ports/MessageStore.js');
const { parseIntent } = await import('../../dist/domains/cats/services/context/IntentParser.js');
const { classifyEntrustedWorkSourceTime } = await import('../../dist/domains/growing/EntrustedWorkSourceSignals.js');
const { custodyOpportunitySample } = await import('../../dist/domains/growing/CustodyOpportunityCohortStore.js');
const { projectCustodyOpportunity } = await import('../../dist/domains/growing/CustodyOpportunitySourceProjection.js');

test('future relative time stays risk-targeted across past aspect, past matrix, and report reset', () => {
  const messages = new MessageStore();
  const policyVersion = 'f310.phase-b.v1';
  const cohort = {
    cohortRef: 'f310-time-direction',
    ownerUserId: 'owner-1',
    policyVersion,
    startedAt: 1_788_170_000_000,
    reviewAt: 1_788_170_000_000 + 30 * 86_400_000,
    samplingPolicy: 'sha256-10-percent-plus-time-signal-v1',
  };
  for (const content of [
    '请在已经确定的发布之前完成修复',
    'we agreed to finish before launch',
    '文档里写着旧方案，现在客户到来之前完成修复',
    'we agreed that the report must finish before launch',
    'the team decided the report should be ready before deployment',
    'we concluded that we will submit before launch',
    'the document says use the old plan, but before lunch we must finish the report',
    '文档里写着旧方案，但客户到来之前要完成修复',
    'the document says use the old plan but we must finish before lunch',
    '文档里写着旧方案但客户到来之前要完成修复',
  ]) {
    let source;
    for (let i = 0; i < 30; i += 1) {
      const candidate = messages.append({
        userId: 'owner-1',
        catId: null,
        content,
        mentions: ['codex-sol'],
        timestamp: cohort.startedAt + 1,
        threadId: 'thread-f310',
      });
      if (!custodyOpportunitySample(`message:${candidate.id}`, policyVersion)) {
        source = candidate;
        break;
      }
    }
    assert.ok(source, content);
    const projection = projectCustodyOpportunity(source, [], cohort, cohort.startedAt + 2 * 3_600_000);
    assert.equal(projection.kind, 'episode', content);
    assert.equal(projection.episode.window.sampling.bucket, 'risk_targeted', content);
  }
});

test('local obligation near before outranks old planning or contrastive reported context', () => {
  for (const source of [
    'we agreed that the report must finish before launch',
    'the team decided the report should be ready before deployment',
    'we concluded that we will submit before launch',
    'the document says use the old plan, but before lunch we must finish the report',
    '文档里写着旧方案，但客户到来之前要完成修复',
    'the document says use the old plan but we must finish before lunch',
    '文档里写着旧方案但客户到来之前要完成修复',
  ]) {
    assert.equal(classifyEntrustedWorkSourceTime(source), 'deadline', source);
  }
  assert.deepEqual(
    parseIntent('we agreed that the report must finish before launch; please deliver the result', 1).promptTags,
    ['skill:custody-recognition'],
  );
  assert.deepEqual(
    parseIntent('the document says use the old plan, but before lunch we must finish the report; please deliver', 1)
      .promptTags,
    ['skill:custody-recognition'],
  );
  assert.deepEqual(parseIntent('文档里写着旧方案，但客户到来之前要帮我完成修复', 1).promptTags, [
    'skill:custody-recognition',
  ]);
  for (const source of [
    'we agreed before launch and now continue',
    'we agreed before launch and now we must finish the report',
    'we agreed before launch, now we must finish the report',
    'the document says use the old plan, before lunch finish the report, now continue',
    'the document says use the old plan, before lunch we must finish the report',
    '文档里写着旧方案，客户到来之前完成修复，现在继续处理',
    '文档里写着旧方案，客户到来之前要完成修复',
  ]) {
    assert.equal(classifyEntrustedWorkSourceTime(source), 'historical_reference', source);
  }
});
