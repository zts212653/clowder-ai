import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { buildLegacyClosureMigrationPlan, buildLegacyClosureTerminalInput } = await import(
  '../dist/scripts/f254-withheld-message-recovery/legacy-closure-migration.js'
);
const {
  buildLegacyClosureMigrationBundle,
  assertLegacyClosureMigrationWriteAllowed,
  collectLegacyWithheldAttachments,
  parseLegacyWithheldLogLine,
  validateLegacyClosureMigrationBundle,
} = await import('../dist/scripts/f254-withheld-message-recovery/legacy-closure-bundle.js');
const { validateRecoveryManifest, sha256Text } = await import(
  '../dist/scripts/f254-withheld-message-recovery/manifest.js'
);
const { InMemoryFreshnessClosureStore } = await import(
  '../dist/domains/cats/services/freshness/FreshnessClosureStore.js'
);

const TARGET_CLOSURE_ID = '29a6b76b-cbe5-4e03-a919-8fb448e6c983';
const TARGET_INVOCATION_ID = 'f69d2fe8-9fec-4aa2-afba-3903c04cf3a8';
const TARGET_CONTENT = [
  '',
  '',
  'F254 本身没有回归，但 merge-gate 被最新 `main` 的独立基线红灯挡住：',
  '',
  '- 同一 glossary test 在 `main@2eaeec4a` 也原样失败，确认与 F254 无关。',
  '- 根因是 PR #2905 的新 `eval:a2a` verdict 引入两个未登记的人类可读 metric。',
  '- 已把阻塞证据投递给 F248/F167 owner；F254 不夹带无关修复。',
  '- F254 已完成 rebase，当前 `f94cbf7d6`，工作树干净；等待 main 修绿后会自动重跑 gate、开 PR。',
  '- 你不需要介入。',
  '',
  '[爪感差: F212 canary 测试 + `finally` 清理仍会在 feature/main worktree 留未跟踪 provider 文件；两份复现均已归口 F212]',
  '',
  '[小太阳·砚砚/GPT-5.6 Sol🐾]',
].join('\n');

function blockedClosure(id, revision = 3) {
  return {
    id,
    userId: 'user-1',
    threadId: 'thread_legacy',
    catId: 'codex-sol',
    originTriggerMessageId: null,
    turnInvocationId: `turn-${id}`,
    status: 'blocked',
    requiredFrontierMessageId: 'msg-frontier',
    requiredMessageIds: ['msg-frontier'],
    observedRawFrontierMessageId: 'msg-frontier',
    baseDraft: { content: 'old', hash: sha256Text('old'), length: 3, invocationId: `base-${id}` },
    latestDraft: { content: 'old', hash: sha256Text('old'), length: 3, invocationId: `turn-${id}` },
    attempts: [],
    automaticSuccessorAttemptCount: 0,
    retryEpoch: 0,
    blockedReason: 'side_effect_requires_explicit_retry',
    revision,
    createdAt: 100,
    updatedAt: 200,
  };
}

function recoveryEntry(invocationId, closureId, content) {
  return {
    invocationId,
    threadId: 'thread_legacy',
    userId: 'user-1',
    catId: 'codex-sol',
    timestamp: 150,
    content,
    contentSha256: sha256Text(content),
    sourceProof: {
      transcriptPath: `data/transcripts/${invocationId}/events.jsonl`,
      sessionId: `session-${invocationId}`,
      firstEventNo: 1,
      lastEventNo: 4,
      terminalEventNo: 4,
      terminalKind: 'f254_withheld_decision',
      withheldDecision: {
        withheldAtUtc: '2026-07-13T03:11:43.743Z',
        closureId,
        decisionKind: 'blocked',
      },
    },
  };
}

function manifest(entries, omissions = []) {
  return validateRecoveryManifest({
    version: 1,
    incident: 'F254',
    generatedAt: '2026-07-13T08:30:00.000Z',
    cvoDecisionRef: '0001783931356596-000046-b727785c',
    entries,
    omissions,
    censusSha256: 'a'.repeat(64),
    censusTotal: entries.length + omissions.length,
  });
}

function recoveredMessage(id, entry) {
  return {
    id,
    threadId: entry.threadId,
    userId: entry.userId,
    catId: entry.catId,
    content: entry.content,
    mentions: [],
    timestamp: entry.timestamp,
    origin: 'stream',
    extra: {
      stream: { invocationId: entry.invocationId, turnInvocationId: entry.invocationId },
      recovery: {
        kind: 'f254_withheld_message',
        invocationId: entry.invocationId,
        manifestSha256: 'b'.repeat(64),
        contentSha256: entry.contentSha256,
        cvoDecisionRef: 'legacy-recovery',
        recoveredAt: 500,
      },
    },
  };
}

function attachment(closureId, invocationId, evidenceRef, source = 'legacy_census') {
  return { closureId, invocationId, source, evidenceRefs: [evidenceRef] };
}

describe('F254 legacy closure accounting', () => {
  test('roots the ledger in every active closure and requires all attached invocations before terminal migration', () => {
    assert.equal([...TARGET_CONTENT].length, 399);
    const oldClosure = blockedClosure('closure-old-census');
    const targetClosure = blockedClosure(TARGET_CLOSURE_ID, 7);
    const restoredEntry = recoveryEntry('invocation-already-restored', oldClosure.id, 'already restored text');
    const targetEntry = recoveryEntry(TARGET_INVOCATION_ID, targetClosure.id, TARGET_CONTENT);
    const recoveryManifest = manifest(
      [restoredEntry, targetEntry],
      [{ invocationId: 'invocation-no-text', reason: 'no_recoverable_text' }],
    );

    const first = buildLegacyClosureMigrationPlan({
      activeClosures: [oldClosure, targetClosure],
      attachments: [
        attachment(oldClosure.id, restoredEntry.invocationId, 'census:line-1'),
        attachment(oldClosure.id, 'invocation-no-text', 'transcript:no-text'),
        // This closure was formed after the frozen old census and must still be included.
        attachment(targetClosure.id, TARGET_INVOCATION_ID, 'runtime-log:2026-07-13T03:11:43.743Z', 'runtime_log'),
      ],
      recoveryManifest,
      existingMessages: [recoveredMessage('msg-restored', restoredEntry)],
      generatedAt: '2026-07-13T08:31:00.000Z',
    });

    assert.equal(first.closures.length, 2);
    const oldPlan = first.closures.find((item) => item.closureId === oldClosure.id);
    assert.deepEqual(
      oldPlan.invocations.map((item) => [item.invocationId, item.outcome]),
      [
        ['invocation-already-restored', 'already_recovered_exact'],
        ['invocation-no-text', 'no_text'],
      ],
    );
    assert.equal(oldPlan.fullyAccounted, true);

    const targetPlan = first.closures.find((item) => item.closureId === TARGET_CLOSURE_ID);
    assert.equal(targetPlan.invocations[0].outcome, 'recoverable_text');
    assert.equal(targetPlan.invocations[0].contentSha256, sha256Text(TARGET_CONTENT));
    assert.equal(targetPlan.fullyAccounted, false);
    assert.throws(
      () =>
        buildLegacyClosureTerminalInput(first, TARGET_CLOSURE_ID, {
          actorId: 'f254-migration',
          evidenceRef: 'migration-manifest',
          now: 1_000,
        }),
      /not fully accounted/i,
    );

    const afterRecovery = buildLegacyClosureMigrationPlan({
      activeClosures: [oldClosure, targetClosure],
      attachments: first.attachments,
      recoveryManifest,
      existingMessages: [
        recoveredMessage('msg-restored', restoredEntry),
        recoveredMessage('msg-target-399', targetEntry),
      ],
      generatedAt: first.generatedAt,
    });
    const terminal = buildLegacyClosureTerminalInput(afterRecovery, TARGET_CLOSURE_ID, {
      actorId: 'f254-migration',
      evidenceRef: 'migration-manifest',
      now: 1_000,
    });
    assert.deepEqual(terminal.invocationIds, [TARGET_INVOCATION_ID]);
    assert.deepEqual(terminal.messageIds, ['msg-target-399']);
    assert.equal(terminal.outcomeCounts.already_recovered_exact, 1);
    assert.equal(terminal.outcomeCounts.no_text, 0);
  });

  test('fails closed on identity conflicts, missing inventory, and one invocation attached to two closures', () => {
    const firstClosure = blockedClosure('closure-first');
    const secondClosure = blockedClosure('closure-second');
    const entry = recoveryEntry('invocation-conflict-1', firstClosure.id, 'expected content');
    const recoveryManifest = manifest([entry]);
    const wrongContent = {
      ...recoveredMessage('msg-wrong', entry),
      content: 'different content',
      extra: {
        stream: {
          invocationId: entry.invocationId,
          turnInvocationId: entry.invocationId,
        },
      },
    };

    const plan = buildLegacyClosureMigrationPlan({
      activeClosures: [firstClosure, secondClosure],
      attachments: [attachment(firstClosure.id, entry.invocationId, 'census:first')],
      recoveryManifest,
      existingMessages: [wrongContent],
      generatedAt: '2026-07-13T08:31:00.000Z',
    });
    assert.equal(plan.closures.find((item) => item.closureId === firstClosure.id).invocations[0].outcome, 'conflict');
    assert.deepEqual(plan.closures.find((item) => item.closureId === secondClosure.id).issues, [
      'no_withheld_invocation_inventory',
    ]);
    assert.equal(plan.summary.conflict, 2);

    assert.throws(
      () =>
        buildLegacyClosureMigrationPlan({
          activeClosures: [firstClosure, secondClosure],
          attachments: [
            attachment(firstClosure.id, entry.invocationId, 'census:first'),
            attachment(secondClosure.id, entry.invocationId, 'runtime-log:second', 'runtime_log'),
          ],
          recoveryManifest,
          existingMessages: [],
          generatedAt: '2026-07-13T08:31:00.000Z',
        }),
      /attached to multiple closures/i,
    );
  });
});

describe('F254 frozen legacy closure migration bundle', () => {
  test('unions 16 census closures with 35 durable post-census turns after runtime logs rotate', () => {
    const closures = Array.from({ length: 51 }, (_, index) => blockedClosure(`closure-inventory-${index}`, index));
    const entries = closures.map((closure, index) =>
      recoveryEntry(closure.turnInvocationId, closure.id, `final-${index}`),
    );
    const census = closures.slice(0, 16).map((closure, index) => ({
      invocationId: entries[index].invocationId,
      userId: closure.userId,
      threadId: closure.threadId,
      catId: closure.catId,
      withheldAtUtc: `2026-07-12T02:${String(index).padStart(2, '0')}:00.000Z`,
      closureId: closure.id,
      decisionKind: 'blocked_known_closure',
      withheldDecision: {
        withheldAtUtc: `2026-07-12T02:${String(index).padStart(2, '0')}:00.000Z`,
        closureId: closure.id,
        decisionKind: 'blocked_known_closure',
      },
    }));
    const attachments = collectLegacyWithheldAttachments({
      closures,
      census,
      logEvents: [],
      legacyBeforeExclusive: '2026-07-13T04:47:19.000Z',
    });
    assert.equal(attachments.length, 51);
    assert.equal(attachments.filter((item) => item.source === 'legacy_census').length, 16);
    assert.equal(attachments.filter((item) => item.source === 'closure_state').length, 35);

    const bundle = buildLegacyClosureMigrationBundle({
      generatedAt: '2026-07-13T08:31:00.000Z',
      legacyBeforeExclusive: '2026-07-13T04:47:19.000Z',
      cvoDecisionRef: '0001783931356596-000046-b727785c',
      closures,
      attachments,
      recoveryManifest: manifest(entries),
    });
    assert.equal(bundle.closures.length, 51);
    assert.match(bundle.bundleSha256, /^[a-f0-9]{64}$/);
    assert.equal(validateLegacyClosureMigrationBundle(bundle).bundleSha256, bundle.bundleSha256);
    assert.throws(
      () =>
        validateLegacyClosureMigrationBundle({
          ...bundle,
          closures: bundle.closures.map((closure, index) =>
            index === 0 ? { ...closure, revision: closure.revision + 1 } : closure,
          ),
        }),
      /bundleSha256 mismatch/i,
    );
    assert.doesNotThrow(() =>
      assertLegacyClosureMigrationWriteAllowed('redis://localhost:6398/15', bundle, { mode: 'preview' }),
    );
    assert.throws(
      () => assertLegacyClosureMigrationWriteAllowed('redis://localhost:6399', bundle, { mode: 'preview' }),
      /production.*refused/i,
    );
    assert.doesNotThrow(() =>
      assertLegacyClosureMigrationWriteAllowed('redis://localhost:6399', bundle, {
        mode: 'production',
        approvalRef: 'cvo-production-signoff',
        expectedBundleSha256: bundle.bundleSha256,
        confirmation: 'MIGRATE F254 LEGACY CLOSURES TO 6399',
      }),
    );

    const previousIsolationFlag = process.env.CAT_CAFE_REDIS_TEST_ISOLATED;
    try {
      delete process.env.CAT_CAFE_REDIS_TEST_ISOLATED;
      assert.throws(
        () =>
          assertLegacyClosureMigrationWriteAllowed('redis://127.0.0.1:6472/15', bundle, {
            mode: 'isolated_test',
          }),
        /sanctioned Redis test harness/i,
      );
      process.env.CAT_CAFE_REDIS_TEST_ISOLATED = '1';
      assert.doesNotThrow(() =>
        assertLegacyClosureMigrationWriteAllowed('redis://127.0.0.1:6472/15', bundle, {
          mode: 'isolated_test',
        }),
      );
      assert.throws(
        () =>
          assertLegacyClosureMigrationWriteAllowed('redis://127.0.0.1:6399/15', bundle, {
            mode: 'isolated_test',
          }),
        /protected Redis port 6399/i,
      );
      assert.throws(
        () =>
          assertLegacyClosureMigrationWriteAllowed('redis://127.0.0.1:6472/14', bundle, {
            mode: 'isolated_test',
          }),
        /database >= 15/i,
      );
      assert.throws(
        () =>
          assertLegacyClosureMigrationWriteAllowed('redis://example.com:6472/15', bundle, {
            mode: 'isolated_test',
          }),
        /loopback Redis/i,
      );
    } finally {
      if (previousIsolationFlag === undefined) delete process.env.CAT_CAFE_REDIS_TEST_ISOLATED;
      else process.env.CAT_CAFE_REDIS_TEST_ISOLATED = previousIsolationFlag;
    }
  });

  test('uses durable turn custody only when retry history proves no other withheld output', () => {
    const collect = (attempts) =>
      collectLegacyWithheldAttachments({
        closures: [{ ...blockedClosure('closure-history'), attempts }],
        census: [],
        logEvents: [],
        legacyBeforeExclusive: '2026-07-13T04:47:19.000Z',
      });
    assert.equal(collect([{ outcome: 'failed' }, { outcome: 'canceled' }])[0].source, 'closure_state');
    for (const outcome of ['superseded', 'committed', 'unknown']) {
      assert.deepEqual(collect([{ outcome }]), [], `${outcome} attempt must block closure_state provenance`);
    }
  });

  test('does not derive closure_state provenance for closures at or after the legacy cutoff', () => {
    const collect = (createdAt) =>
      collectLegacyWithheldAttachments({
        closures: [{ ...blockedClosure('closure-cutoff'), createdAt }],
        census: [],
        logEvents: [],
        legacyBeforeExclusive: '2026-07-13T04:47:19.000Z',
      });
    const cutoff = Date.parse('2026-07-13T04:47:19.000Z');
    assert.equal(collect(cutoff - 1)[0].source, 'closure_state');
    assert.deepEqual(collect(cutoff), []);
    assert.deepEqual(collect(cutoff + 1), []);
  });

  test('parses only exact withheld log events with line-addressable evidence', () => {
    assert.equal(parseLegacyWithheldLogLine('{"msg":"other"}', 'api.log', 1), null);
    const parsed = parseLegacyWithheldLogLine(
      JSON.stringify({
        time: '2026-07-13T03:11:43.743Z',
        threadId: 'thread_legacy',
        catId: 'codex-sol',
        invocationId: TARGET_INVOCATION_ID,
        decision: {
          kind: 'blocked_known_closure',
          closureId: TARGET_CLOSURE_ID,
        },
        msg: '[F254-E] draft withheld from normal thread final',
      }),
      'packages/api/data/logs/api/api.2026-07-12.1.log',
      42,
    );
    assert.equal(parsed.closureId, TARGET_CLOSURE_ID);
    assert.equal(
      parsed.evidenceRef,
      'api-log:packages/api/data/logs/api/api.2026-07-12.1.log#L42@2026-07-13T03:11:43.743Z',
    );
  });
});

describe('F254 explicit legacy closure terminal transition', () => {
  test('removes only a fully-accounted closure from active hydration and is exactly idempotent', async () => {
    const store = new InMemoryFreshnessClosureStore();
    const opened = await store.openOrAdvance({
      closureId: 'closure-store-migrated',
      userId: 'user-1',
      threadId: 'thread_legacy',
      catId: 'codex-sol',
      invocationId: 'invocation-store-base',
      draftContent: 'legacy draft',
      requiredMessageIds: ['msg-frontier'],
      requiredFrontierMessageId: 'msg-frontier',
      observedRawFrontierMessageId: 'msg-frontier',
      replayUnsafeToolNames: ['Edit'],
      now: 100,
    });
    await store.openOrAdvance({
      closureId: 'closure-store-unresolved',
      userId: 'user-1',
      threadId: 'thread_legacy',
      catId: 'codex-sol',
      invocationId: 'invocation-store-unresolved',
      draftContent: 'still unresolved',
      requiredMessageIds: ['msg-frontier'],
      requiredFrontierMessageId: 'msg-frontier',
      observedRawFrontierMessageId: 'msg-frontier',
      replayUnsafeToolNames: ['Edit'],
      now: 100,
    });
    const entry = recoveryEntry('invocation-store-final', opened.id, 'formal final');
    const recoveryManifest = manifest([entry]);
    const plan = buildLegacyClosureMigrationPlan({
      activeClosures: await store.listAllActive(),
      attachments: [attachment(opened.id, entry.invocationId, 'transcript:store-final')],
      recoveryManifest,
      existingMessages: [recoveredMessage('msg-store-final', entry)],
      generatedAt: '2026-07-13T08:31:00.000Z',
    });
    const input = buildLegacyClosureTerminalInput(plan, opened.id, {
      actorId: 'f254-migration',
      evidenceRef: 'migration-manifest',
      now: 1_000,
    });

    const migrated = await store.migrateLegacy(opened.id, input);
    assert.equal(migrated.status, 'disposed');
    assert.equal(migrated.disposition.kind, 'legacy_migrated');
    assert.deepEqual(migrated.disposition.invocationIds, [entry.invocationId]);
    assert.deepEqual(
      (await store.listAllActive()).map((closure) => closure.id),
      ['closure-store-unresolved'],
    );
    assert.deepEqual(await store.listActiveByThread('thread_legacy'), [await store.get('closure-store-unresolved')]);

    const rerun = await store.migrateLegacy(opened.id, input);
    assert.equal(rerun.revision, migrated.revision);
    const rerunByAnotherOperator = await store.migrateLegacy(opened.id, {
      ...input,
      actorId: 'f254-migration-resume-operator',
    });
    assert.equal(rerunByAnotherOperator.revision, migrated.revision);
    assert.equal(rerunByAnotherOperator.disposition.actorId, 'f254-migration');
    await assert.rejects(
      store.migrateLegacy(opened.id, { ...input, accountingSha256: 'f'.repeat(64) }),
      /different legacy migration/i,
    );
  });
});
