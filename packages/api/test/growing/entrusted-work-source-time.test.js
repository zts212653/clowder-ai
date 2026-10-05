import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import '../helpers/setup-cat-registry.js';

const { InvocationRegistry } = await import('../../dist/domains/cats/services/agents/invocation/InvocationRegistry.js');
const { MessageStore } = await import('../../dist/domains/cats/services/stores/ports/MessageStore.js');
const { TaskStore } = await import('../../dist/domains/cats/services/stores/ports/TaskStore.js');
const { ThreadStore } = await import('../../dist/domains/cats/services/stores/ports/ThreadStore.js');
const { classifyEntrustedWorkSourceTime } = await import('../../dist/domains/growing/EntrustedWorkSourceSignals.js');
const { parseIntent } = await import('../../dist/domains/cats/services/context/IntentParser.js');
const { custodyOpportunitySample } = await import('../../dist/domains/growing/CustodyOpportunityCohortStore.js');
const { projectCustodyOpportunity } = await import('../../dist/domains/growing/CustodyOpportunitySourceProjection.js');
const { callbacksRoutes } = await import('../../dist/routes/callbacks.js');

test('source time separates deadlines, historical references, and unresolved relative attachment', () => {
  for (const source of [
    '那你把要改要修复的整理一下，有什么继续推动之前的那个thread来做',
    '回到之前的那个 thread 继续处理这个问题',
    '之前我们讨论过这个方案，现在继续开发',
    '我们之前把那个 thread 的事整理过，现在继续处理',
    '我们很久之前把那个 thread 的事整理过',
    '在很久之前把方案讨论过',
    'before we discussed this, keep working on that thread',
    '发布之前，我们讨论过这个方案，现在继续处理',
    '在客户到来之前，我们讨论过这个方案，现在继续处理',
    'before the launch, we discussed the plan and then continued',
    '发布之前，我们已经讨论了这个方案，现在继续处理',
    '发布之前，我们已经完成测试，现在继续处理',
    '他说，发布之前提交方案，现在继续处理',
    'I said before lunch, send me the report',
    '发布之前，已经完成测试，现在继续处理',
    '他刚才说过，发布之前提交方案，现在继续处理',
    '文档里写着，发布之前提交方案，现在继续处理',
    'the document says, before launch finish the demo, now continue',
    '需求文档里写着，发布之前提交方案，现在继续处理',
    'the design document says, before launch finish the demo, now continue',
    'go back to before launch and continue the repair',
    'return to the state before launch and keep working',
    'return to the previous state before launch and keep working',
    'go back to just before launch and continue the repair',
  ]) {
    assert.equal(classifyEntrustedWorkSourceTime(source), 'historical_reference', source);
  }
  for (const source of [
    '周四之前把演示准备好',
    '发布之前提交方案',
    '在客户到来之前完成',
    '三天以内完成修复',
    '下周交付',
    'before the launch, finish the demo',
    '客户到来之前完成修复',
    '老板回来之前交付方案',
    '睡觉之前把报告发我',
    'before the client arrives, finish the demo',
    'before lunch, send me the report',
    '考试之前复核材料',
    'before lunch, email me the report',
    'before the planned launch, finish the demo',
    'finish what we planned before lunch',
    '他说，发布之前提交方案。客户到来之前完成修复',
    '他说，发布之前提交方案，现在客户到来之前完成修复',
    'the design document says, before launch finish the demo, now before lunch finish the report',
    '要在发布之前已经完成测试',
    '请在客户到来之前已经准备好材料',
    '请在已经确定的发布之前完成修复',
    '我们现在要在发布之前已经完成修复',
    '要在已经排定的演示之前完成材料',
    '在已经确认的评审之前提交方案',
    '文档里写着旧方案，现在客户到来之前完成修复',
    '他说过旧方案，现在客户到来之前完成修复',
    'the design document says use the old plan, now before lunch finish the report',
    'we agreed to finish before launch',
    'we planned to submit before deployment',
    'we were supposed to finish before launch',
    'the report was scheduled to finish before launch',
    '请在发布之前回到旧版本',
    '回到发布之前，客户到来之前完成修复',
    '回到发布之前继续处理并在客户到来之前完成修复',
    'go back to before launch and then finish before lunch',
  ]) {
    assert.equal(classifyEntrustedWorkSourceTime(source), 'deadline', source);
  }
  for (const source of [
    '回到发布之前继续处理',
    '请回到发布之前继续处理',
    '恢复到客户到来之前继续处理',
    '回到办公室之前提交报告',
    '回到北京之前继续准备材料',
    '回到团队之前继续整理材料',
    '回到客户那边之前继续修复',
    'return to the office before lunch',
    'go back to the office before lunch',
    '返回公司之前把报告发我',
    'roll back to previous version before deployment',
    'we must roll back to previous version before deployment',
  ]) {
    assert.equal(classifyEntrustedWorkSourceTime(source), 'ambiguous', source);
  }
  assert.equal(classifyEntrustedWorkSourceTime('继续处理方案'), 'none');
});

async function ownerHarness(sourceContent) {
  const taskStore = new TaskStore();
  const messageStore = new MessageStore();
  const threadStore = new ThreadStore();
  threadStore.ensureThread('thread-f310', 'F310 source-time test');
  const source = messageStore.append({
    userId: 'owner-1',
    catId: null,
    content: sourceContent,
    mentions: ['codex-sol'],
    timestamp: 1_788_170_000_000,
    threadId: 'thread-f310',
  });
  const registry = new InvocationRegistry();
  const app = Fastify();
  await app.register(callbacksRoutes, {
    registry,
    messageStore,
    socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
    taskStore,
    threadStore,
  });
  const credentials = await registry.create('owner-1', 'codex-sol', 'thread-f310');
  const headers = {
    'x-invocation-id': credentials.invocationId,
    'x-callback-token': credentials.callbackToken,
  };
  const payload = {
    title: 'Return to entrusted work',
    admission: {
      basis: 'explicit_entrustment',
      sourceRefs: [`message:${source.id}`],
      intendedOutcome: 'A reviewable repair is ready',
      idempotencyKey: `source-time:${source.id}`,
    },
    closure: { condition: 'The repair is reviewable', expectedSignal: 'artifact:repair' },
  };
  const admit = (overrides = {}) =>
    app.inject({
      method: 'POST',
      url: '/api/callbacks/admit-entrusted-work',
      headers,
      payload: { ...payload, ...overrides },
    });
  return { app, admit, taskStore, source };
}

test('untimed explicit return to a previous thread admits once without invented time', async () => {
  const { app, admit, taskStore } = await ownerHarness(
    '那你把要改 要修复的整理一下 有什么继续推动之前的那个thread来做，有什么 是独立的你可以新建thread来做？ 布偶猫猫粮不多了你可以让两代sol来协同',
  );
  try {
    const admitted = await admit();
    const resumed = await admit();
    assert.equal(admitted.statusCode, 200);
    assert.equal(admitted.json().status, 'admitted');
    assert.equal(resumed.json().status, 'resumed');
    assert.equal(resumed.json().task.id, admitted.json().task.id);
    assert.deepEqual(admitted.json().task.entrustedWork.time, {});
    assert.equal(taskStore.listByThread('thread-f310').length, 1);
  } finally {
    await app.close();
  }
});

test('deadline or ambiguous relative time never admits without a source-backed time decision', async () => {
  for (const source of [
    '发布之前提交方案',
    '客户到来之前完成修复',
    '老板回来之前交付方案',
    '睡觉之前把报告发我',
    'before the client arrives, finish the demo',
    'before lunch, send me the report',
    '要在发布之前已经完成测试',
    '请在客户到来之前已经准备好材料',
    '请在已经确定的发布之前完成修复',
    '我们现在要在发布之前已经完成修复',
    '要在已经排定的演示之前完成材料',
    '在已经确认的评审之前提交方案',
    '文档里写着旧方案，现在客户到来之前完成修复',
    '他说过旧方案，现在客户到来之前完成修复',
    'the design document says use the old plan, now before lunch finish the report',
    'we agreed to finish before launch',
    'we planned to submit before deployment',
    'we were supposed to finish before launch',
    'the report was scheduled to finish before launch',
    'we agreed that the report must finish before launch',
    'the team decided the report should be ready before deployment',
    'we concluded that we will submit before launch',
    'the document says use the old plan, but before lunch we must finish the report',
    '文档里写着旧方案，但客户到来之前要完成修复',
    '回到办公室之前提交报告',
    '返回公司之前把报告发我',
    'roll back to previous version before deployment',
    'we must roll back to previous version before deployment',
    '回到发布之前继续处理并在客户到来之前完成修复',
    '回到北京之前继续准备材料',
    '回到团队之前继续整理材料',
    '回到客户那边之前继续修复',
    '他说，发布之前提交方案，现在客户到来之前完成修复',
    'the design document says, before launch finish the demo, now before lunch finish the report',
    '回到发布之前继续处理',
  ]) {
    const { app, admit, taskStore } = await ownerHarness(source);
    try {
      const omitted = await admit();
      assert.equal(omitted.statusCode, 200, source);
      assert.equal(omitted.json().status, 'needs_clarification', source);
      assert.equal(taskStore.listByThread('thread-f310').length, 0, source);
      if (classifyEntrustedWorkSourceTime(source) === 'ambiguous') {
        assert.match(omitted.json().admission.clarificationReason, /could be a deadline or a past reference/u, source);
      }
    } finally {
      await app.close();
    }
  }
});

test('an ambiguous source cannot be converted into a deadline by a typed assertion alone', async () => {
  const { app, admit, taskStore, source } = await ownerHarness('回到北京之前继续准备材料');
  try {
    const result = await admit({
      time: { businessDeadline: { value: 1_788_170_000_000 + 86_400_000, sourceRef: `message:${source.id}` } },
    });
    assert.equal(result.json().status, 'needs_clarification');
    assert.match(result.json().admission.clarificationReason, /could be a deadline or a past reference/u);
    assert.equal(taskStore.listByThread('thread-f310').length, 0);
  } finally {
    await app.close();
  }
});

test('historical event narration admits and replays without an invented deadline', async () => {
  for (const source of [
    '发布之前，我们讨论过这个方案，现在继续处理',
    '在客户到来之前，我们讨论过这个方案，现在继续处理',
    '发布之前，已经完成测试，现在继续处理',
    '他刚才说过，发布之前提交方案，现在继续处理',
    '文档里写着，发布之前提交方案，现在继续处理',
    '发布之前，我们已经完成测试，现在继续处理',
    'go back to before launch and continue the repair',
    'return to the state before launch and keep working',
    'return to the previous state before launch and keep working',
    'go back to just before launch and continue the repair',
    '需求文档里写着，发布之前提交方案，现在继续处理',
    'the design document says, before launch finish the demo, now continue',
  ]) {
    const { app, admit, taskStore } = await ownerHarness(source);
    try {
      const admitted = await admit();
      const resumed = await admit();
      assert.equal(admitted.json().status, 'admitted', source);
      assert.equal(resumed.json().status, 'resumed', source);
      assert.equal(resumed.json().task.id, admitted.json().task.id, source);
      assert.deepEqual(admitted.json().task.entrustedWork.time, {}, source);
      assert.equal(taskStore.listByThread('thread-f310').length, 1, source);
    } finally {
      await app.close();
    }
  }
});

test('soft entry sees arbitrary future events without waking on a historical time reference', () => {
  assert.deepEqual(parseIntent('客户到来之前，帮我完成修复', 1).promptTags, ['skill:custody-recognition']);
  assert.deepEqual(parseIntent('请你在客户到来之前已经准备好材料', 1).promptTags, ['skill:custody-recognition']);
  assert.deepEqual(parseIntent('回到发布之前继续处理并在客户到来之前帮我完成修复', 1).promptTags, [
    'skill:custody-recognition',
  ]);
  assert.deepEqual(parseIntent('他说，发布之前提交方案，现在客户到来之前帮我完成修复', 1).promptTags, [
    'skill:custody-recognition',
  ]);
  assert.deepEqual(parseIntent('请在已经确定的发布之前帮我完成修复', 1).promptTags, ['skill:custody-recognition']);
  assert.deepEqual(parseIntent('文档里写着旧方案，现在客户到来之前帮我完成修复', 1).promptTags, [
    'skill:custody-recognition',
  ]);
  assert.deepEqual(parseIntent('we agreed to finish before launch; please deliver the result', 1).promptTags, [
    'skill:custody-recognition',
  ]);
  assert.deepEqual(parseIntent('发布之前，我们讨论过这个方案，现在请你继续处理', 1).promptTags, []);
  assert.deepEqual(parseIntent('回到发布之前继续处理，麻烦你整理方案', 1).promptTags, ['skill:custody-recognition']);
  assert.deepEqual(parseIntent('他刚才说过，发布之前提交方案，现在请你继续处理', 1).promptTags, []);
  assert.deepEqual(parseIntent('需求文档里写着，发布之前提交方案，现在请你继续处理', 1).promptTags, []);
  assert.deepEqual(
    parseIntent('the document says, before launch finish the demo; please continue preparing', 1).promptTags,
    [],
  );
  assert.deepEqual(
    parseIntent('the design document says, before launch finish the demo; please continue preparing', 1).promptTags,
    [],
  );
});

test('historical event narration is not a risk-targeted custody sample', () => {
  const messageStore = new MessageStore();
  const policyVersion = 'f310.phase-b.v1';
  const cohort = {
    cohortRef: 'f310-test-cohort',
    ownerUserId: 'owner-1',
    policyVersion,
    startedAt: 1_788_170_000_000,
    reviewAt: 1_788_170_000_000 + 30 * 86_400_000,
    samplingPolicy: 'sha256-10-percent-plus-time-signal-v1',
  };
  for (const content of [
    '发布之前，我们讨论过这个方案，现在继续处理',
    '他刚才说过，发布之前提交方案，现在继续处理',
    'the document says, before launch finish the demo, now continue',
    '需求文档里写着，发布之前提交方案，现在继续处理',
    'the design document says, before launch finish the demo, now continue',
  ]) {
    let source;
    for (let i = 0; i < 30; i += 1) {
      const candidate = messageStore.append({
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
    assert.ok(source);
    assert.equal(projectCustodyOpportunity(source, [], cohort, cohort.startedAt + 2 * 3_600_000).kind, 'excluded');
  }
  let ambiguous;
  for (let i = 0; i < 30; i += 1) {
    const candidate = messageStore.append({
      userId: 'owner-1',
      catId: null,
      content: '回到发布之前继续处理',
      mentions: ['codex-sol'],
      timestamp: cohort.startedAt + 1,
      threadId: 'thread-f310',
    });
    if (!custodyOpportunitySample(`message:${candidate.id}`, policyVersion)) {
      ambiguous = candidate;
      break;
    }
  }
  assert.ok(ambiguous);
  const projection = projectCustodyOpportunity(ambiguous, [], cohort, cohort.startedAt + 2 * 3_600_000);
  assert.equal(projection.kind, 'episode');
  assert.equal(projection.episode.window.sampling.bucket, 'risk_targeted');
});
