import { mock } from 'node:test';

export async function collect(iterable) {
  const messages = [];
  for await (const msg of iterable) messages.push(msg);
  return messages;
}

export function createMockBridge({
  steps = [
    {
      type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
      status: 'CORTEX_STEP_STATUS_DONE',
      plannerResponse: { response: 'Meow!' },
    },
  ],
  cascadeId = 'test-cascade-001',
  pollError = null,
} = {}) {
  return {
    ensureConnected: mock.fn(async () => ({ port: 1234, csrfToken: 'test', useTls: false })),
    startCascade: mock.fn(async () => cascadeId),
    sendMessage: mock.fn(async () => 0),
    getTrajectorySteps: mock.fn(async () => steps),
    getTrajectory: mock.fn(async () => ({ status: 'CASCADE_RUN_STATUS_IDLE', numTotalSteps: steps.length })),
    pollForSteps: pollError
      ? mock.fn(async function* () {
          throw new Error(pollError);
        })
      : mock.fn(async function* () {
          yield {
            steps,
            cursor: {
              baselineStepCount: 0,
              lastDeliveredStepCount: steps.length,
              terminalSeen: true,
              lastActivityAt: Date.now(),
            },
          };
        }),
    getOrCreateSession: mock.fn(async () => cascadeId),
    resolveModelId: mock.fn(
      (name) => ({ 'gemini-3.1-pro': 'MODEL_PLACEHOLDER_M37', 'claude-opus-4-6': 'MODEL_PLACEHOLDER_M26' })[name],
    ),
    nativeExecuteAndPush: mock.fn(async () => false),
  };
}
