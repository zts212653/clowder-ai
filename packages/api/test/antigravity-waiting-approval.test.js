import assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';
import { AntigravityAgentService } from '../dist/domains/cats/services/agents/providers/antigravity/AntigravityAgentService.js';
import { AntigravityBridge } from '../dist/domains/cats/services/agents/providers/antigravity/AntigravityBridge.js';

function createBridge() {
  return new AntigravityBridge({ port: 1234, csrfToken: 'test', useTls: false });
}

async function collect(iterable) {
  const messages = [];
  for await (const msg of iterable) messages.push(msg);
  return messages;
}

function createMockServiceBridge({ resolveOutstandingSteps, approvePendingInteraction } = {}) {
  const resolveOutstandingStepsMock = resolveOutstandingSteps ?? mock.fn(async () => {});
  const approvePendingInteractionMock =
    approvePendingInteraction ??
    mock.fn(async (cascadeId, step) => {
      if (step?.type !== 'CORTEX_STEP_TYPE_CODE_ACTION') await resolveOutstandingStepsMock(cascadeId);
    });
  return {
    ensureConnected: mock.fn(async () => ({ port: 1234, csrfToken: 'test', useTls: false })),
    startCascade: mock.fn(async () => 'test-cascade-001'),
    // F211-REG8: sendMessage now returns { stepsBefore, wasBusy } (was a bare number).
    sendMessage: mock.fn(async () => ({ stepsBefore: 0, wasBusy: false })),
    getTrajectorySteps: mock.fn(async () => []),
    getTrajectory: mock.fn(async () => ({ status: 'CASCADE_RUN_STATUS_IDLE', numTotalSteps: 0 })),
    pollForSteps: mock.fn(async function* () {
      yield {
        steps: [],
        cursor: {
          baselineStepCount: 0,
          lastDeliveredStepCount: 0,
          terminalSeen: false,
          lastActivityAt: Date.now(),
          awaitingUserInput: true,
        },
      };
      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            status: 'DONE',
            plannerResponse: { response: 'browser approved' },
          },
        ],
        cursor: {
          baselineStepCount: 0,
          lastDeliveredStepCount: 1,
          terminalSeen: true,
          lastActivityAt: Date.now(),
        },
      };
    }),
    getOrCreateSession: mock.fn(async () => 'test-cascade-001'),
    resolveModelId: mock.fn(() => 'MODEL_PLACEHOLDER_M26'),
    resolveOutstandingSteps: resolveOutstandingStepsMock,
    approvePendingInteraction: approvePendingInteractionMock,
    nativeExecuteAndPush: mock.fn(async () => false),
  };
}

function createWaitingFileCodeActionStep({ id, name, stepIndex }) {
  const argumentsJson =
    name === 'replace_file_content'
      ? JSON.stringify({ TargetFile: 'docs/probe.md', Search: 'old', Replace: 'probe' })
      : JSON.stringify({ TargetFile: 'docs/probe.md', CodeContent: 'probe\n' });
  return {
    type: 'CORTEX_STEP_TYPE_CODE_ACTION',
    status: 'CORTEX_STEP_STATUS_WAITING',
    metadata: {
      sourceTrajectoryStepInfo: { trajectoryId: 'traj-1', stepIndex },
      toolCall: { id, name, argumentsJson },
    },
    requestedInteraction: {
      permission: {
        resource: {
          action: 'write_file',
          target: 'docs/probe.md',
        },
      },
    },
  };
}

function createExistingAwaitingCodeActionBridge({
  resolveOutstandingSteps,
  approvePendingInteraction,
  waitingSteps,
  response = 'write approved after existing wait step',
}) {
  const totalSteps = 9 + waitingSteps.length;
  return {
    ...createMockServiceBridge({ resolveOutstandingSteps, approvePendingInteraction }),
    getTrajectory: mock.fn(async () => ({
      status: 'CASCADE_RUN_STATUS_RUNNING',
      numTotalSteps: totalSteps,
      awaitingUserInput: true,
      trajectory: {
        steps: Array.from({ length: 9 }, () => ({
          type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
          status: 'DONE',
        })).concat(...waitingSteps),
      },
      updatedAt: Date.now(),
    })),
    pollForSteps: mock.fn(async function* () {
      yield {
        steps: [],
        cursor: {
          baselineStepCount: totalSteps,
          lastDeliveredStepCount: totalSteps,
          terminalSeen: false,
          lastActivityAt: Date.now(),
          awaitingUserInput: true,
        },
      };
      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            status: 'DONE',
            plannerResponse: { response },
          },
        ],
        cursor: {
          baselineStepCount: totalSteps,
          lastDeliveredStepCount: totalSteps + 1,
          terminalSeen: true,
          lastActivityAt: Date.now(),
        },
      };
    }),
  };
}

describe('Antigravity waiting approval', () => {
  test('pollForSteps yields awaiting-user-input state instead of throwing stall', async () => {
    const bridge = createBridge();
    mock.method(bridge, 'getTrajectory', async () => ({
      status: 'CASCADE_RUN_STATUS_RUNNING',
      numTotalSteps: 0,
      awaitingUserInput: true,
    }));

    const ac = new AbortController();
    const iter = bridge.pollForSteps('cascade-1', 0, 100, 20, ac.signal)[Symbol.asyncIterator]();

    const first = await iter.next();
    assert.equal(first.done, false);
    assert.equal(first.value.steps.length, 0);
    assert.equal(first.value.cursor.awaitingUserInput, true);

    ac.abort();
    await assert.rejects(async () => {
      await iter.next();
    }, /abort/i);
  });

  test('service auto-approves via resolveOutstandingSteps when autoApprove=true (default)', async () => {
    const resolveOutstandingSteps = mock.fn(async () => {});
    const bridge = createMockServiceBridge({ resolveOutstandingSteps });
    const service = new AntigravityAgentService({ catId: 'antigravity', model: 'claude-opus-4-6', bridge });

    const messages = await collect(service.invoke('open browser'));

    assert.equal(resolveOutstandingSteps.mock.calls.length, 1, 'resolveOutstandingSteps should be called once');
    assert.equal(resolveOutstandingSteps.mock.calls[0].arguments[0], 'test-cascade-001');

    const waiting = messages.find((msg) => msg.type === 'liveness_signal');
    assert.equal(waiting, undefined, 'should NOT emit liveness_signal when auto-approve succeeds');

    const texts = messages.filter((msg) => msg.type === 'text');
    assert.equal(texts.length, 1);
    assert.equal(texts[0].content, 'browser approved');
  });

  test('service falls back to generic resolve when awaiting trajectory inspection fails', async () => {
    const resolveOutstandingSteps = mock.fn(async () => {});
    const bridge = {
      ...createMockServiceBridge({ resolveOutstandingSteps }),
      getTrajectory: mock.fn(async () => {
        throw new Error('transient trajectory failure');
      }),
    };
    const service = new AntigravityAgentService({ catId: 'antigravity', model: 'claude-opus-4-6', bridge });

    const messages = await collect(service.invoke('open browser'));

    assert.equal(resolveOutstandingSteps.mock.calls.length, 1, 'generic resolve should remain the fallback');
    assert.equal(resolveOutstandingSteps.mock.calls[0].arguments[0], 'test-cascade-001');
    const waiting = messages.find((msg) => msg.type === 'liveness_signal');
    assert.equal(waiting, undefined, 'fallback resolve should avoid user-visible waiting when it clears');
  });

  test('service falls back to liveness_signal when auto-approve fails', async () => {
    const resolveOutstandingSteps = mock.fn(async () => {
      throw new Error('ResolveOutstandingSteps: 400 — invalid');
    });
    const bridge = createMockServiceBridge({ resolveOutstandingSteps });
    const service = new AntigravityAgentService({ catId: 'antigravity', model: 'claude-opus-4-6', bridge });

    const messages = await collect(service.invoke('open browser'));

    assert.equal(resolveOutstandingSteps.mock.calls.length, 1, 'should attempt auto-approve');

    const waiting = messages.find((msg) => msg.type === 'liveness_signal');
    assert.ok(waiting, 'should fall back to liveness_signal on failure');
    const parsed = JSON.parse(waiting.content);
    assert.match(parsed.message, /等待权限批准/);
  });

  test('service emits liveness_signal when resolve succeeds but awaitingUserInput persists', async () => {
    const resolveOutstandingSteps = mock.fn(async () => {});
    const bridge = {
      ...createMockServiceBridge({ resolveOutstandingSteps }),
      pollForSteps: mock.fn(async function* () {
        // 1st batch: awaitingUserInput — service should try auto-approve
        yield {
          steps: [],
          cursor: {
            baselineStepCount: 0,
            lastDeliveredStepCount: 0,
            terminalSeen: false,
            lastActivityAt: Date.now(),
            awaitingUserInput: true,
          },
        };
        // 2nd batch: STILL awaitingUserInput — resolve was a no-op
        yield {
          steps: [],
          cursor: {
            baselineStepCount: 0,
            lastDeliveredStepCount: 0,
            terminalSeen: false,
            lastActivityAt: Date.now(),
            awaitingUserInput: true,
          },
        };
        // 3rd batch: finally resolved
        yield {
          steps: [{ type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'DONE', plannerResponse: { response: 'done' } }],
          cursor: { baselineStepCount: 0, lastDeliveredStepCount: 1, terminalSeen: true, lastActivityAt: Date.now() },
        };
      }),
    };
    const service = new AntigravityAgentService({ catId: 'antigravity', model: 'claude-opus-4-6', bridge });

    const messages = await collect(service.invoke('open browser'));

    // Should only attempt resolve ONCE, not retry on second awaitingUserInput
    assert.equal(resolveOutstandingSteps.mock.calls.length, 1, 'should attempt resolve only once');

    // Must emit liveness_signal on the second awaitingUserInput (resolve didn't work)
    const waiting = messages.filter((msg) => msg.type === 'liveness_signal');
    assert.ok(waiting.length >= 1, 'must emit liveness_signal when resolve did not clear awaitingUserInput');
  });

  test('service step-approves existing waiting CODE_ACTIONs when awaitingUserInput has no new steps', async () => {
    const resolveOutstandingSteps = mock.fn(async () => {});
    const approvePendingInteraction = mock.fn(async () => {});
    const firstWaitingStep = createWaitingFileCodeActionStep({
      id: 'toolu_existing_replace_file_content',
      name: 'replace_file_content',
      stepIndex: 9,
    });
    const secondWaitingStep = createWaitingFileCodeActionStep({
      id: 'toolu_existing_write_to_file',
      name: 'write_to_file',
      stepIndex: 10,
    });
    const bridge = createExistingAwaitingCodeActionBridge({
      resolveOutstandingSteps,
      approvePendingInteraction,
      waitingSteps: [firstWaitingStep, secondWaitingStep],
    });
    const service = new AntigravityAgentService({ catId: 'antigravity', model: 'claude-opus-4-6', bridge });

    const messages = await collect(service.invoke('write file'));

    assert.equal(
      approvePendingInteraction.mock.calls.length,
      2,
      'existing permission CODE_ACTIONs should trigger the approval router',
    );
    assert.equal(approvePendingInteraction.mock.calls[0].arguments[0], 'test-cascade-001');
    assert.equal(approvePendingInteraction.mock.calls[0].arguments[1], firstWaitingStep);
    assert.equal(approvePendingInteraction.mock.calls[1].arguments[0], 'test-cascade-001');
    assert.equal(approvePendingInteraction.mock.calls[1].arguments[1], secondWaitingStep);
    assert.equal(resolveOutstandingSteps.mock.calls.length, 0, 'permission CODE_ACTION must not use generic resolve');
    const text = messages.find((msg) => msg.type === 'text');
    assert.equal(text?.content, 'write approved after existing wait step');
  });

  test('service continues approving later existing CODE_ACTIONs after one approval fails', async () => {
    const resolveOutstandingSteps = mock.fn(async () => {});
    const firstWaitingStep = createWaitingFileCodeActionStep({
      id: 'toolu_existing_replace_file_content',
      name: 'replace_file_content',
      stepIndex: 9,
    });
    const secondWaitingStep = createWaitingFileCodeActionStep({
      id: 'toolu_existing_write_to_file',
      name: 'write_to_file',
      stepIndex: 10,
    });
    const approvePendingInteraction = mock.fn(async (_cascadeId, step) => {
      if (step === firstWaitingStep) throw new Error('permission rpc failed once');
    });
    const bridge = createExistingAwaitingCodeActionBridge({
      resolveOutstandingSteps,
      approvePendingInteraction,
      waitingSteps: [firstWaitingStep, secondWaitingStep],
      response: 'later write approved after partial failure',
    });
    const service = new AntigravityAgentService({ catId: 'antigravity', model: 'claude-opus-4-6', bridge });

    const messages = await collect(service.invoke('write file'));

    assert.equal(approvePendingInteraction.mock.calls.length, 2, 'should not stop after the first failure');
    assert.equal(
      resolveOutstandingSteps.mock.calls.length,
      0,
      'one successful step-specific approval should avoid generic resolve',
    );
    const text = messages.find((msg) => msg.type === 'text');
    assert.equal(text?.content, 'later write approved after partial failure');
  });

  test('service falls back to generic resolve when all existing CODE_ACTION approvals fail', async () => {
    const resolveOutstandingSteps = mock.fn(async () => {});
    const approvePendingInteraction = mock.fn(async () => {
      throw new Error('permission rpc unavailable');
    });
    const firstWaitingStep = createWaitingFileCodeActionStep({
      id: 'toolu_existing_replace_file_content',
      name: 'replace_file_content',
      stepIndex: 9,
    });
    const secondWaitingStep = createWaitingFileCodeActionStep({
      id: 'toolu_existing_write_to_file',
      name: 'write_to_file',
      stepIndex: 10,
    });
    const bridge = createExistingAwaitingCodeActionBridge({
      resolveOutstandingSteps,
      approvePendingInteraction,
      waitingSteps: [firstWaitingStep, secondWaitingStep],
      response: 'generic resolve recovered after approval failures',
    });
    const service = new AntigravityAgentService({ catId: 'antigravity', model: 'claude-opus-4-6', bridge });

    const messages = await collect(service.invoke('write file'));

    assert.equal(approvePendingInteraction.mock.calls.length, 2, 'should attempt every existing CODE_ACTION');
    assert.equal(
      resolveOutstandingSteps.mock.calls.length,
      1,
      'all step-specific failures should fall back to generic resolve',
    );
    assert.equal(resolveOutstandingSteps.mock.calls[0].arguments[0], 'test-cascade-001');
    const text = messages.find((msg) => msg.type === 'text');
    assert.equal(text?.content, 'generic resolve recovered after approval failures');
  });

  test('env var ANTIGRAVITY_AUTO_APPROVE=false disables auto-approve', async () => {
    const original = process.env['ANTIGRAVITY_AUTO_APPROVE'];
    try {
      process.env['ANTIGRAVITY_AUTO_APPROVE'] = 'false';
      const resolveOutstandingSteps = mock.fn(async () => {});
      const bridge = createMockServiceBridge({ resolveOutstandingSteps });
      // No explicit autoApprove option — should read from env
      const service = new AntigravityAgentService({ catId: 'antigravity', model: 'claude-opus-4-6', bridge });

      const messages = await collect(service.invoke('open browser'));

      assert.equal(resolveOutstandingSteps.mock.calls.length, 0, 'should NOT call resolve when env disables it');
      const waiting = messages.find((msg) => msg.type === 'liveness_signal');
      assert.ok(waiting, 'should emit liveness_signal');
    } finally {
      if (original === undefined) delete process.env['ANTIGRAVITY_AUTO_APPROVE'];
      else process.env['ANTIGRAVITY_AUTO_APPROVE'] = original;
    }
  });

  test('service probes resolveOutstandingSteps on stall when autoApprove=true (no awaitingUserInput)', async () => {
    const resolveOutstandingSteps = mock.fn(async () => {});
    const bridge = {
      ...createMockServiceBridge({ resolveOutstandingSteps }),
      pollForSteps: mock.fn(async function* () {
        // Simulate stall: RUNNING but no awaitingUserInput flag, bridge throws stall
        throw new Error('Antigravity stall: no activity for 60213ms (steps=5, status=CASCADE_RUN_STATUS_RUNNING)');
      }),
    };
    let callCount = 0;
    // Replace pollForSteps: first call throws stall, second call succeeds after probe
    bridge.pollForSteps = mock.fn(async function* () {
      callCount++;
      if (callCount === 1) {
        throw new Error('Antigravity stall: no activity for 60213ms (steps=5, status=CASCADE_RUN_STATUS_RUNNING)');
      }
      // After probe-approve, cascade unblocks
      yield {
        steps: [
          { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'DONE', plannerResponse: { response: 'probed ok' } },
        ],
        cursor: { baselineStepCount: 0, lastDeliveredStepCount: 1, terminalSeen: true, lastActivityAt: Date.now() },
      };
    });
    const service = new AntigravityAgentService({ catId: 'antigravity', model: 'claude-opus-4-6', bridge });

    const messages = await collect(service.invoke('open browser'));

    assert.equal(resolveOutstandingSteps.mock.calls.length, 1, 'should probe resolveOutstandingSteps on stall');
    const texts = messages.filter((msg) => msg.type === 'text');
    assert.equal(texts.length, 1, 'should get response after probe unblocks cascade');
    assert.equal(texts[0].content, 'probed ok');
  });

  test('service auto-approves approval_pending RUN_COMMAND even when cursor.awaitingUserInput is false', async () => {
    const resolveOutstandingSteps = mock.fn(async () => {});
    const approvePendingInteraction = mock.fn(async (cascadeId) => {
      await resolveOutstandingSteps(cascadeId);
    });
    const waitingStep = {
      type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
      status: 'CORTEX_STEP_STATUS_WAITING',
      metadata: {
        toolCall: {
          id: 'toolu_waiting_without_cursor_flag',
          name: 'run_command',
          argumentsJson: JSON.stringify({ CommandLine: 'echo hi', Cwd: '/tmp', SafeToAutoRun: false }),
        },
      },
    };
    const bridge = {
      ...createMockServiceBridge({ resolveOutstandingSteps, approvePendingInteraction }),
      nativeExecuteAndPush: mock.fn(async (step) =>
        step.type === 'CORTEX_STEP_TYPE_RUN_COMMAND' ? 'approval_pending' : false,
      ),
      pollForSteps: mock.fn(async function* () {
        yield {
          steps: [waitingStep],
          cursor: {
            baselineStepCount: 0,
            lastDeliveredStepCount: 0,
            terminalSeen: false,
            lastActivityAt: Date.now(),
            awaitingUserInput: false,
          },
        };
        yield {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              status: 'DONE',
              plannerResponse: { response: 'approved without waiting for stall' },
            },
          ],
          cursor: { baselineStepCount: 0, lastDeliveredStepCount: 1, terminalSeen: true, lastActivityAt: Date.now() },
        };
      }),
    };
    const service = new AntigravityAgentService({ catId: 'antigravity', model: 'claude-opus-4-6', bridge });

    const messages = await collect(service.invoke('run command'));

    assert.equal(approvePendingInteraction.mock.calls.length, 1, 'approval_pending should trigger the approval router');
    assert.equal(approvePendingInteraction.mock.calls[0].arguments[0], 'test-cascade-001');
    assert.equal(approvePendingInteraction.mock.calls[0].arguments[1], waitingStep);
    assert.equal(
      resolveOutstandingSteps.mock.calls.length,
      1,
      'run_command approval should delegate to generic resolve',
    );
    assert.equal(resolveOutstandingSteps.mock.calls[0].arguments[0], 'test-cascade-001');
    assert.equal(
      messages.some((msg) => msg.type === 'liveness_signal'),
      false,
      'successful immediate auto-approve should not show waiting UI',
    );
    const text = messages.find((msg) => msg.type === 'text');
    assert.equal(text?.content, 'approved without waiting for stall');
  });

  test('service auto-approves approval_pending LS-owned write tools without unsupported_waiting_tool', async () => {
    const resolveOutstandingSteps = mock.fn(async () => {});
    const approvePendingInteraction = mock.fn(async () => {});
    const waitingStep = {
      type: 'CORTEX_STEP_TYPE_CODE_ACTION',
      status: 'CORTEX_STEP_STATUS_WAITING',
      metadata: {
        toolCall: {
          id: 'toolu_write_to_file',
          name: 'write_to_file',
          argumentsJson: JSON.stringify({ Path: 'docs/probe.md', Content: 'probe' }),
        },
      },
    };
    const bridge = {
      ...createMockServiceBridge({ resolveOutstandingSteps, approvePendingInteraction }),
      nativeExecuteAndPush: mock.fn(async (step) =>
        step.metadata?.toolCall?.name === 'write_to_file' ? 'approval_pending' : false,
      ),
      pollForSteps: mock.fn(async function* () {
        yield {
          steps: [waitingStep],
          cursor: {
            baselineStepCount: 0,
            lastDeliveredStepCount: 0,
            terminalSeen: false,
            lastActivityAt: Date.now(),
            awaitingUserInput: false,
          },
        };
        yield {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              status: 'DONE',
              plannerResponse: { response: 'write approved by LS' },
            },
          ],
          cursor: { baselineStepCount: 0, lastDeliveredStepCount: 1, terminalSeen: true, lastActivityAt: Date.now() },
        };
      }),
    };
    const service = new AntigravityAgentService({ catId: 'antigravity', model: 'claude-opus-4-6', bridge });

    const messages = await collect(service.invoke('write file'));

    assert.equal(
      approvePendingInteraction.mock.calls.length,
      1,
      'LS-owned write tool should trigger code-action aware auto-approve',
    );
    assert.equal(approvePendingInteraction.mock.calls[0].arguments[0], 'test-cascade-001');
    assert.equal(approvePendingInteraction.mock.calls[0].arguments[1], waitingStep);
    assert.equal(
      resolveOutstandingSteps.mock.calls.length,
      0,
      'CODE_ACTION must not use generic resolve-only approval',
    );
    assert.equal(
      messages.some((msg) => msg.type === 'error' && msg.errorCode === 'unsupported_waiting_tool'),
      false,
      'LS-owned write tool approval must not be surfaced as unsupported',
    );
    const text = messages.find((msg) => msg.type === 'text');
    assert.equal(text?.content, 'write approved by LS');
  });

  test('service does not generic-probe a still-waiting CODE_ACTION after auto-approve stall', async () => {
    const resolveOutstandingSteps = mock.fn(async () => {});
    const approvePendingInteraction = mock.fn(async () => {});
    const waitingStep = {
      type: 'CORTEX_STEP_TYPE_CODE_ACTION',
      status: 'CORTEX_STEP_STATUS_WAITING',
      metadata: {
        sourceTrajectoryStepInfo: { trajectoryId: 'traj-1', stepIndex: 7 },
        toolCall: {
          id: 'toolu_write_to_file_still_waiting',
          name: 'write_to_file',
          argumentsJson: JSON.stringify({
            TargetFile: '.scratch/antigravity-write-smoke-test.txt',
            CodeContent: 'smoke\n',
          }),
        },
      },
      requestedInteraction: {
        permission: {
          resource: {
            action: 'write_file',
            target: '.scratch/antigravity-write-smoke-test.txt',
          },
        },
      },
    };
    let pollCount = 0;
    const bridge = {
      ...createMockServiceBridge({ resolveOutstandingSteps, approvePendingInteraction }),
      getTrajectory: mock.fn(async () => ({
        status: 'CASCADE_RUN_STATUS_RUNNING',
        numTotalSteps: 1,
        awaitingUserInput: false,
        trajectory: { steps: [waitingStep] },
        updatedAt: Date.now(),
      })),
      nativeExecuteAndPush: mock.fn(async (step) => (step === waitingStep ? 'approval_pending' : false)),
      pollForSteps: mock.fn(async function* () {
        pollCount += 1;
        if (pollCount === 1) {
          yield {
            steps: [waitingStep],
            cursor: {
              baselineStepCount: 0,
              lastDeliveredStepCount: 1,
              terminalSeen: false,
              lastActivityAt: Date.now(),
              awaitingUserInput: false,
            },
          };
          throw new Error('Antigravity stall: no activity for 60213ms (steps=1, status=CASCADE_RUN_STATUS_RUNNING)');
        }
        yield {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              status: 'DONE',
              plannerResponse: { response: 'write eventually applied by LS' },
            },
          ],
          cursor: {
            baselineStepCount: 1,
            lastDeliveredStepCount: 2,
            terminalSeen: true,
            lastActivityAt: Date.now(),
          },
        };
      }),
    };
    const service = new AntigravityAgentService({ catId: 'antigravity', model: 'claude-opus-4-6', bridge });

    const messages = await collect(service.invoke('write file'));

    assert.equal(approvePendingInteraction.mock.calls.length, 1, 'CODE_ACTION should be auto-approved once');
    assert.equal(
      resolveOutstandingSteps.mock.calls.length,
      0,
      'still-waiting CODE_ACTION must not be canceled by generic stall probe',
    );
    assert.equal(bridge.pollForSteps.mock.calls.length, 2, 'service should keep polling after CODE_ACTION stall');
    const text = messages.find((msg) => msg.type === 'text');
    assert.equal(text?.content, 'write eventually applied by LS');
  });

  test('service bounds repeated CODE_ACTION wait stalls without generic resolve', async () => {
    const resolveOutstandingSteps = mock.fn(async () => {});
    const approvePendingInteraction = mock.fn(async () => {});
    const waitingStep = {
      type: 'CORTEX_STEP_TYPE_CODE_ACTION',
      status: 'CORTEX_STEP_STATUS_WAITING',
      metadata: {
        sourceTrajectoryStepInfo: { trajectoryId: 'traj-1', stepIndex: 7 },
        toolCall: {
          id: 'toolu_write_to_file_never_applies',
          name: 'write_to_file',
          argumentsJson: JSON.stringify({
            TargetFile: '.scratch/antigravity-write-smoke-test.txt',
            CodeContent: 'smoke\n',
          }),
        },
      },
      requestedInteraction: {
        permission: {
          resource: {
            action: 'write_file',
            target: '.scratch/antigravity-write-smoke-test.txt',
          },
        },
      },
    };
    let pollCount = 0;
    const bridge = {
      ...createMockServiceBridge({ resolveOutstandingSteps, approvePendingInteraction }),
      getTrajectory: mock.fn(async () => ({
        status: 'CASCADE_RUN_STATUS_RUNNING',
        numTotalSteps: 1,
        awaitingUserInput: false,
        trajectory: { steps: [waitingStep] },
        updatedAt: Date.now(),
      })),
      nativeExecuteAndPush: mock.fn(async (step) => (step === waitingStep ? 'approval_pending' : false)),
      pollForSteps: mock.fn(async function* () {
        pollCount += 1;
        if (pollCount > 3) {
          throw new Error('unbounded CODE_ACTION wait loop');
        }
        if (pollCount === 1) {
          yield {
            steps: [waitingStep],
            cursor: {
              baselineStepCount: 0,
              lastDeliveredStepCount: 1,
              terminalSeen: false,
              lastActivityAt: Date.now(),
              awaitingUserInput: false,
            },
          };
        }
        throw new Error('Antigravity stall: no activity for 60213ms (steps=1, status=CASCADE_RUN_STATUS_RUNNING)');
      }),
    };
    const service = new AntigravityAgentService({ catId: 'antigravity', model: 'claude-opus-4-6', bridge });

    const messages = await collect(service.invoke('write file'));

    assert.equal(approvePendingInteraction.mock.calls.length, 1, 'CODE_ACTION should be auto-approved once');
    assert.equal(resolveOutstandingSteps.mock.calls.length, 0, 'CODE_ACTION wait stalls must not use generic resolve');
    assert.equal(bridge.pollForSteps.mock.calls.length, 3, 'CODE_ACTION wait stalls must be bounded');
    const errors = messages.filter((msg) => msg.type === 'error');
    assert.ok(errors.length >= 1, 'bounded CODE_ACTION wait should surface a stall error');
    assert.match(errors[0].error, /Antigravity stall/i);
    assert.doesNotMatch(errors[0].error, /unbounded CODE_ACTION wait loop/);
  });

  test('service auto-approves multiple approval_pending steps in the same batch', async () => {
    const resolveOutstandingSteps = mock.fn(async () => {});
    const approvePendingInteraction = mock.fn(async (cascadeId, step) => {
      if (step.type !== 'CORTEX_STEP_TYPE_CODE_ACTION') await resolveOutstandingSteps(cascadeId);
    });
    const writeStep = {
      type: 'CORTEX_STEP_TYPE_CODE_ACTION',
      status: 'CORTEX_STEP_STATUS_WAITING',
      metadata: {
        toolCall: {
          id: 'toolu_write_to_file_first',
          name: 'write_to_file',
          argumentsJson: JSON.stringify({ Path: 'docs/probe.md', Content: 'probe' }),
        },
      },
    };
    const runCommandStep = {
      type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
      status: 'CORTEX_STEP_STATUS_WAITING',
      metadata: {
        toolCall: {
          id: 'toolu_run_command_second',
          name: 'run_command',
          argumentsJson: JSON.stringify({ CommandLine: 'echo hi', Cwd: '/tmp', SafeToAutoRun: false }),
        },
      },
    };
    const bridge = {
      ...createMockServiceBridge({ resolveOutstandingSteps, approvePendingInteraction }),
      nativeExecuteAndPush: mock.fn(async (step) =>
        step === writeStep || step === runCommandStep ? 'approval_pending' : false,
      ),
      pollForSteps: mock.fn(async function* () {
        yield {
          steps: [writeStep, runCommandStep],
          cursor: {
            baselineStepCount: 0,
            lastDeliveredStepCount: 0,
            terminalSeen: false,
            lastActivityAt: Date.now(),
            awaitingUserInput: false,
          },
        };
        yield {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              status: 'DONE',
              plannerResponse: { response: 'both approvals cleared' },
            },
          ],
          cursor: { baselineStepCount: 0, lastDeliveredStepCount: 1, terminalSeen: true, lastActivityAt: Date.now() },
        };
      }),
    };
    const service = new AntigravityAgentService({ catId: 'antigravity', model: 'claude-opus-4-6', bridge });

    const messages = await collect(service.invoke('write file then run command'));

    assert.equal(approvePendingInteraction.mock.calls.length, 2, 'each pending approval step should be approved once');
    assert.equal(approvePendingInteraction.mock.calls[0].arguments[1], writeStep);
    assert.equal(approvePendingInteraction.mock.calls[1].arguments[1], runCommandStep);
    assert.equal(resolveOutstandingSteps.mock.calls.length, 1, 'run_command approval should still use generic resolve');
    assert.equal(
      messages.some((msg) => msg.type === 'liveness_signal'),
      false,
      'multiple successful auto-approvals should not show waiting UI',
    );
    const text = messages.find((msg) => msg.type === 'text');
    assert.equal(text?.content, 'both approvals cleared');
  });

  test('P1: probe retry resumes from last delivered cursor, not from stepsBefore', async () => {
    const resolveOutstandingSteps = mock.fn(async () => {});
    let callCount = 0;
    const bridge = {
      ...createMockServiceBridge({ resolveOutstandingSteps }),
      pollForSteps: mock.fn(async function* () {
        callCount++;
        if (callCount === 1) {
          // First poll: deliver one step, then stall
          yield {
            steps: [
              {
                type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                status: 'DONE',
                plannerResponse: { response: 'first chunk' },
              },
            ],
            cursor: {
              baselineStepCount: 0,
              lastDeliveredStepCount: 1,
              terminalSeen: false,
              lastActivityAt: Date.now(),
            },
          };
          throw new Error('Antigravity stall: no activity for 60213ms (steps=1, status=CASCADE_RUN_STATUS_RUNNING)');
        }
        // Second poll (after probe): only the NEW step, not the old one
        yield {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              status: 'DONE',
              plannerResponse: { response: 'second chunk' },
            },
          ],
          cursor: {
            baselineStepCount: 1,
            lastDeliveredStepCount: 2,
            terminalSeen: true,
            lastActivityAt: Date.now(),
          },
        };
      }),
    };
    const service = new AntigravityAgentService({ catId: 'antigravity', model: 'claude-opus-4-6', bridge });

    const messages = await collect(service.invoke('open browser'));

    const texts = messages.filter((msg) => msg.type === 'text');
    // Must be exactly 2 text messages, no duplicates
    assert.equal(texts.length, 2, 'must not replay already-delivered steps');
    assert.equal(texts[0].content, 'first chunk');
    assert.equal(texts[1].content, 'second chunk');

    // pollForSteps must have been called with updated cursor on retry
    assert.equal(bridge.pollForSteps.mock.calls.length, 2);
    // Second call should start from step 1 (last delivered), not 0 (original stepsBefore)
    assert.equal(bridge.pollForSteps.mock.calls[1].arguments[1], 1, 'retry must resume from lastDeliveredStepCount=1');
    assert.equal(
      bridge.pollForSteps.mock.calls[1].arguments[6],
      0,
      'retry must preserve original replay baseline separately from the resume cursor',
    );
  });

  test('P1: busy-reuse retry preserves follow-up wait after old-tail stall', async () => {
    const resolveOutstandingSteps = mock.fn(async () => {});
    let callCount = 0;
    const bridge = {
      ...createMockServiceBridge({ resolveOutstandingSteps }),
      sendMessage: mock.fn(async () => ({ stepsBefore: 0, wasBusy: true })),
      getTrajectory: mock.fn(async () => ({ status: 'CASCADE_RUN_STATUS_IDLE', numTotalSteps: 2 })),
      pollForSteps: mock.fn(
        async function* (_cascadeId, fromStep, _timeoutMs, _intervalMs, _signal, expectFollowUpTurn) {
          callCount++;
          if (callCount === 1) {
            assert.equal(fromStep, 0);
            assert.equal(expectFollowUpTurn, true, 'first busy-reuse poll must wait for follow-up USER_INPUT');
            yield {
              steps: [
                {
                  type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                  status: 'DONE',
                  plannerResponse: { response: 'old turn tail' },
                },
              ],
              cursor: {
                baselineStepCount: 0,
                lastDeliveredStepCount: 2,
                terminalSeen: false,
                lastActivityAt: Date.now(),
              },
            };
            throw new Error('Antigravity stall: no activity for 60213ms (steps=2, status=CASCADE_RUN_STATUS_IDLE)');
          }
          yield {
            steps: [
              {
                type: 'CORTEX_STEP_TYPE_USER_INPUT',
                status: 'DONE',
                userInput: { items: [{ text: 'follow-up question' }] },
              },
              {
                type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                status: 'DONE',
                plannerResponse: { response: 'follow-up answer' },
              },
            ],
            cursor: {
              baselineStepCount: 0,
              lastDeliveredStepCount: 4,
              terminalSeen: true,
              lastActivityAt: Date.now(),
            },
          };
        },
      ),
    };
    const service = new AntigravityAgentService({ catId: 'antigravity', model: 'claude-opus-4-6', bridge });

    const messages = await collect(service.invoke('follow-up question'));

    assert.equal(bridge.pollForSteps.mock.calls.length, 2);
    assert.equal(bridge.pollForSteps.mock.calls[1].arguments[1], 2, 'retry still resumes from last delivered');
    assert.equal(
      bridge.pollForSteps.mock.calls[1].arguments[5],
      true,
      'retry must keep waiting for the follow-up USER_INPUT after old-tail progress',
    );
    assert.equal(
      bridge.pollForSteps.mock.calls[1].arguments[6],
      0,
      'retry must still preserve the original replay baseline',
    );
    const texts = messages.filter((msg) => msg.type === 'text').map((msg) => msg.content);
    assert.deepEqual(texts, ['old turn tail', 'follow-up answer']);
  });

  test('AC-G1: keeps waiting across repeated stalls when trajectory still shows liveness', async () => {
    const resolveOutstandingSteps = mock.fn(async () => {});
    let pollCount = 0;
    let trajectoryCount = 0;
    const bridge = {
      ...createMockServiceBridge({ resolveOutstandingSteps }),
      getTrajectory: mock.fn(async () => {
        trajectoryCount += 1;
        return {
          status: 'CASCADE_RUN_STATUS_RUNNING',
          numTotalSteps: trajectoryCount,
          updatedAt: Date.now() + trajectoryCount,
        };
      }),
      pollForSteps: mock.fn(async function* () {
        pollCount += 1;
        if (pollCount <= 2) {
          throw new Error(
            `Antigravity stall: no activity for 60213ms (steps=${pollCount}, status=CASCADE_RUN_STATUS_RUNNING)`,
          );
        }
        yield {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              status: 'DONE',
              plannerResponse: { response: 'still alive' },
            },
          ],
          cursor: {
            baselineStepCount: 0,
            lastDeliveredStepCount: 1,
            terminalSeen: true,
            lastActivityAt: Date.now(),
          },
        };
      }),
    };
    const service = new AntigravityAgentService({ catId: 'antigravity', model: 'claude-opus-4-6', bridge });

    const messages = await collect(service.invoke('long task'));

    const texts = messages.filter((msg) => msg.type === 'text');
    assert.equal(texts.length, 1);
    assert.equal(texts[0].content, 'still alive');
    assert.equal(resolveOutstandingSteps.mock.calls.length, 0, 'liveness stall must not burn approval probes');
    assert.equal(bridge.pollForSteps.mock.calls.length, 3, 'must continue polling after repeated live stalls');
  });

  test('AC-G1: uses bounded multi-probe budget before treating repeated dead stalls as fatal', async () => {
    const resolveOutstandingSteps = mock.fn(async () => {});
    let pollCount = 0;
    const bridge = {
      ...createMockServiceBridge({ resolveOutstandingSteps }),
      pollForSteps: mock.fn(async function* () {
        pollCount += 1;
        if (pollCount <= 2) {
          throw new Error(`Antigravity stall: no activity for 60213ms (steps=0, status=CASCADE_RUN_STATUS_RUNNING)`);
        }
        yield {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              status: 'DONE',
              plannerResponse: { response: 'unblocked after second probe' },
            },
          ],
          cursor: {
            baselineStepCount: 0,
            lastDeliveredStepCount: 1,
            terminalSeen: true,
            lastActivityAt: Date.now(),
          },
        };
      }),
    };
    const service = new AntigravityAgentService({ catId: 'antigravity', model: 'claude-opus-4-6', bridge });

    const messages = await collect(service.invoke('long task'));

    const texts = messages.filter((msg) => msg.type === 'text');
    assert.equal(texts.length, 1);
    assert.equal(texts[0].content, 'unblocked after second probe');
    assert.equal(resolveOutstandingSteps.mock.calls.length, 2, 'should have a bounded multi-probe budget');
    assert.equal(bridge.pollForSteps.mock.calls.length, 3);
  });

  test('AC-G1: pending approval trajectory still consumes an approval probe', async () => {
    const resolveOutstandingSteps = mock.fn(async () => {});
    let pollCount = 0;
    const bridge = {
      ...createMockServiceBridge({ resolveOutstandingSteps }),
      getTrajectory: mock.fn(async () => ({
        status: 'CASCADE_RUN_STATUS_RUNNING',
        numTotalSteps: 0,
        awaitingUserInput: true,
        updatedAt: Date.now(),
      })),
      pollForSteps: mock.fn(async function* () {
        pollCount += 1;
        if (pollCount === 1) {
          throw new Error('Antigravity stall: no activity for 60213ms (steps=0, status=CASCADE_RUN_STATUS_RUNNING)');
        }
        yield {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              status: 'DONE',
              plannerResponse: { response: 'approved after pending approval probe' },
            },
          ],
          cursor: {
            baselineStepCount: 0,
            lastDeliveredStepCount: 1,
            terminalSeen: true,
            lastActivityAt: Date.now(),
          },
        };
      }),
    };
    const service = new AntigravityAgentService({ catId: 'antigravity', model: 'claude-opus-4-6', bridge });

    const messages = await collect(service.invoke('long task'));

    const texts = messages.filter((msg) => msg.type === 'text');
    assert.equal(texts.length, 1);
    assert.equal(texts[0].content, 'approved after pending approval probe');
    assert.equal(
      resolveOutstandingSteps.mock.calls.length,
      1,
      'pending approval must not be treated as passive liveness',
    );
  });

  test('service does not probe on stall when autoApprove=false', async () => {
    const resolveOutstandingSteps = mock.fn(async () => {});
    const bridge = {
      ...createMockServiceBridge({ resolveOutstandingSteps }),
      pollForSteps: mock.fn(async function* () {
        throw new Error('Antigravity stall: no activity for 60213ms (steps=5, status=CASCADE_RUN_STATUS_RUNNING)');
      }),
    };
    const service = new AntigravityAgentService({
      catId: 'antigravity',
      model: 'claude-opus-4-6',
      bridge,
      autoApprove: false,
    });

    const messages = await collect(service.invoke('open browser'));

    assert.equal(resolveOutstandingSteps.mock.calls.length, 0, 'should NOT probe when autoApprove=false');
    const errors = messages.filter((msg) => msg.type === 'error');
    assert.ok(errors.length >= 1, 'should emit error on stall');
    assert.match(errors[0].error, /stall/i);
  });

  test('service emits liveness_signal when autoApprove=false', async () => {
    const resolveOutstandingSteps = mock.fn(async () => {});
    const bridge = createMockServiceBridge({ resolveOutstandingSteps });
    const service = new AntigravityAgentService({
      catId: 'antigravity',
      model: 'claude-opus-4-6',
      bridge,
      autoApprove: false,
    });

    const messages = await collect(service.invoke('open browser'));

    assert.equal(resolveOutstandingSteps.mock.calls.length, 0, 'should NOT call resolveOutstandingSteps');

    const waiting = messages.find((msg) => msg.type === 'liveness_signal');
    assert.ok(waiting, 'should emit liveness_signal when auto-approve disabled');
    const parsed = JSON.parse(waiting.content);
    assert.equal(parsed.type, 'info');
    assert.match(parsed.message, /等待权限批准/);
  });

  test('Bug-7 P1: keeps upstream_error when stream_error also present in same batch', async () => {
    const bridge = {
      ...createMockServiceBridge(),
      pollForSteps: mock.fn(async function* () {
        // LS sends generic stream_error THEN specific upstream_error in one batch
        yield {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              status: 'DONE',
              plannerResponse: { stopReason: 'STOP_REASON_CLIENT_STREAM_ERROR' },
            },
            {
              type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
              status: 'DONE',
              errorMessage: { error: { userErrorMessage: 'The model produced an invalid tool call.' } },
            },
          ],
          cursor: {
            baselineStepCount: 0,
            lastDeliveredStepCount: 2,
            terminalSeen: true,
            lastActivityAt: Date.now(),
          },
        };
      }),
    };
    const service = new AntigravityAgentService({ catId: 'antigravity', model: 'claude-opus-4-6', bridge });

    const messages = await collect(service.invoke('test'));

    const errors = messages.filter((msg) => msg.type === 'error');
    // Must keep the more specific upstream_error, not swallow it behind stream_error
    const hasUpstream = errors.some((e) => e.errorCode === 'upstream_error');
    assert.ok(hasUpstream, 'upstream_error must NOT be suppressed when stream_error also present');
    assert.equal(errors.find((e) => e.errorCode === 'upstream_error').error, '工具调用失败');
    // stream_error should be suppressed in favor of upstream_error
    const hasStream = errors.some((e) => e.errorCode === 'stream_error');
    assert.equal(hasStream, false, 'stream_error should be suppressed when upstream_error provides more detail');
  });

  test('G10: model_capacity error emitted correctly at service level', async () => {
    const bridge = {
      ...createMockServiceBridge(),
      pollForSteps: mock.fn(async function* () {
        yield {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
              status: 'DONE',
              errorMessage: {
                error: {
                  userErrorMessage:
                    'Our servers are experiencing high traffic right now, please try again in a minute.',
                },
              },
            },
          ],
          cursor: {
            baselineStepCount: 0,
            lastDeliveredStepCount: 1,
            terminalSeen: true,
            lastActivityAt: Date.now(),
          },
        };
      }),
    };
    const service = new AntigravityAgentService({
      catId: 'antigravity',
      model: 'claude-opus-4-6',
      bridge,
      modelCapacityRetryDelaysMs: [],
    });

    const messages = await collect(service.invoke('test'));

    const errors = messages.filter((m) => m.type === 'error');
    assert.equal(errors.length, 1, 'should emit exactly one error');
    assert.equal(errors[0].errorCode, 'model_capacity', 'high traffic must be classified as model_capacity');
    assert.equal(errors[0].error, '上游模型服务繁忙');
  });

  test('G10: model_capacity with tool activity still classifies correctly', async () => {
    const bridge = {
      ...createMockServiceBridge(),
      pollForSteps: mock.fn(async function* () {
        yield {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_TOOL_CALL',
              status: 'DONE',
              toolCall: { toolName: 'web_search', input: '{}' },
            },
            {
              type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
              status: 'DONE',
              errorMessage: {
                error: {
                  userErrorMessage:
                    'Our servers are experiencing high traffic right now, please try again in a minute.',
                },
              },
            },
          ],
          cursor: {
            baselineStepCount: 0,
            lastDeliveredStepCount: 2,
            terminalSeen: true,
            lastActivityAt: Date.now(),
          },
        };
      }),
    };
    const service = new AntigravityAgentService({
      catId: 'antigravity',
      model: 'claude-opus-4-6',
      bridge,
      modelCapacityRetryDelaysMs: [],
    });

    const messages = await collect(service.invoke('test'));

    const errors = messages.filter((m) => m.type === 'error');
    assert.ok(errors.length >= 1, 'should emit error');
    assert.equal(errors[0].errorCode, 'model_capacity');
  });

  test('Bug-7: deduplicates consecutive upstream_error in same batch', async () => {
    const bridge = {
      ...createMockServiceBridge(),
      pollForSteps: mock.fn(async function* () {
        // LS sends two identical ERROR_MESSAGE steps in one batch
        yield {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
              status: 'DONE',
              errorMessage: { error: { userErrorMessage: 'The model produced an invalid tool call.' } },
            },
            {
              type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
              status: 'DONE',
              errorMessage: { error: { userErrorMessage: 'The model produced an invalid tool call.' } },
            },
          ],
          cursor: {
            baselineStepCount: 0,
            lastDeliveredStepCount: 2,
            terminalSeen: true,
            lastActivityAt: Date.now(),
          },
        };
      }),
    };
    const service = new AntigravityAgentService({ catId: 'antigravity', model: 'claude-opus-4-6', bridge });

    const messages = await collect(service.invoke('test'));

    const errors = messages.filter((msg) => msg.type === 'error');
    // Must yield only ONE error to the user, not two identical red bars
    assert.equal(errors.length, 1, 'duplicate upstream_error must be deduplicated to single error');
    assert.equal(errors[0].error, '工具调用失败');
  });
});
