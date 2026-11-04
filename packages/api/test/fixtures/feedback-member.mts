import assert from 'node:assert/strict';

/** Native output is synthetic; the real module action must acknowledge every
 * delivery exactly as SubscriptionDelivery requires before advancing a cursor. */
export function configuredFeedbackMember(invoke: (input: Record<string, unknown>) => Promise<unknown>) {
  let runs = 0;
  let prompt = '';
  let deliveries = 0;
  const deliver = async (input: Record<string, unknown>) => {
    const deliveryId = `delivery-${++deliveries}`;
    assert.deepEqual(await invoke({ ...input, deliveryId }), { deliveryId });
  };
  const member = { catId: 'configured', displayName: '已配置 Client', defaultModel: 'fixture', available: true };
  return {
    members: { list: async () => [member], get: async () => member },
    messaging: {
      subscribe: async () => {},
      unsubscribe: async () => {},
      send: async (input: {
        threadId: string;
        wake: { catId: string };
        payload: { elements: { payload: { text: string } }[] };
      }) => {
        assert.equal(input.wake.catId, member.catId);
        prompt = input.payload.elements[0]!.payload.text;
        const messageId = `request-${++runs}`;
        const executionId = `execution-${runs}`;
        setTimeout(async () => {
          await deliver({
            kind: 'execution_status',
            threadId: input.threadId,
            state: 'started',
            replyTo: messageId,
            executionId,
          });
          await deliver({
            kind: 'message',
            threadId: input.threadId,
            executionId,
            envelope: {
              actor: { kind: 'cat', id: member.catId },
              payload: {
                elements: [
                  {
                    kind: 'text',
                    payload: {
                      text: '# 分析后的标题\n\n## 初步分析\n事实：E_TIMEOUT\n推测：信息不足\n未验证：尚未复现\napi_key=model-secret-canary\n\n[伙伴/fixture🐾]',
                    },
                  },
                ],
              },
            },
          });
          await deliver({
            kind: 'execution_status',
            threadId: input.threadId,
            state: 'settled',
            chainDone: true,
            outcome: 'completed',
            executionId,
          });
        }, 5000);
        return { messageId, threadId: input.threadId };
      },
    },
    modelPrompt: () => prompt,
    modelRuns: () => runs,
  };
}
