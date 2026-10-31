/** Original F306 request shapes; the real service owns publication, host epoch and provider waiter. */
export function providerRequest({ id, kind, language, owner, threadId }) {
  const en = language === 'en';
  const decisions = [
    { id: 'accept', label: en ? 'Allow once' : '允许一次', outcome: 'accept' },
    { id: 'decline', label: en ? 'Decline' : '拒绝', outcome: 'decline' },
    { id: 'cancel', label: en ? 'Cancel' : '取消', outcome: 'cancel' },
  ];
  const common = {
    version: 1,
    interactionId: `provider-native-${id}`,
    // Each independently waiting upstream request has its own invocation.
    // The real store correctly permits only one active provider request per invocation.
    owner: { userId: owner, threadId, catId: 'codex61-sol', invocationId: `owned-provider-request-${id}` },
    provider: {
      providerId: 'openai',
      method:
        kind === 'approval'
          ? 'item/commandExecution/requestApproval'
          : kind === 'question'
            ? 'item/tool/requestUserInput'
            : 'mcpServer/elicitation/request',
      requestId: `rpc-${id}`,
    },
    createdAt: Date.now(),
    title: `${en ? 'Original request' : '原请求'} ${id}`,
  };
  if (kind === 'approval') return { ...common, kind, description: 'pnpm test — isolated specimen', decisions };
  if (kind === 'question')
    return {
      ...common,
      kind,
      questions: [
        {
          id: 'environment',
          header: en ? 'Environment' : '环境',
          question: en ? 'Where should it run?' : '在哪里运行？',
          options: [{ label: 'Alpha' }, { label: 'Local' }],
        },
      ],
    };
  const base = {
    ...common,
    kind: 'elicitation',
    decisions,
    message: en ? 'Choose the verification target.' : '选择验证目标。',
  };
  if (kind === 'url')
    return { ...base, mode: 'url', elicitationId: `elicit-${id}`, url: 'https://example.invalid/authorize' };
  if (kind !== 'form') throw new Error(`Unsupported fixture kind ${kind}`);
  return {
    ...base,
    mode: 'form',
    requestedSchema: {
      type: 'object',
      properties: { enabled: { type: 'boolean', title: en ? 'Enabled' : '启用' } },
      required: ['enabled'],
      additionalProperties: false,
    },
  };
}
