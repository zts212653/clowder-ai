import { THREAD_ID } from './f307-real-surface-fixtures.mjs';

// Synthetic API evidence; production components, host, CSS, navigation and resize run unchanged.
export const firstSentence = `You，${'同一条原生消息的完整首句保持来源和标点'.repeat(9)}。`;
const native = {
  provider: 'codex',
  runtimeSessionId: 'fixture-native-session',
  turnId: 'fixture-turn',
  nativeId: 'first-message',
};
const firstContent = `${firstSentence}后一句不能当首句补位。`;
export const summary = {
  invocationId: `inv-fixture-${'full-call-identity-'.repeat(7)}`,
  threadId: THREAD_ID,
  sessionId: `session-fixture-${'exact-session-identity-'.repeat(5)}`,
  sessionSeq: 2,
  sessionStatus: 'sealed',
  catId: 'codex61-sol',
  status: 'done',
  startedAt: 1000,
  endedAt: 85000,
  durationMs: 84000,
  eventCount: 124,
  statusEventCount: 100,
  toolUseCount: 3,
  toolResultCount: 1,
  messageCount: 7,
  errorCount: 1,
  toolNames: ['exec_command'],
  keyMessages: ['You，'],
  tokens: { input: 1234, output: 321 },
};
summary.firstAssistantOutputEvidence = {
  role: 'assistant',
  complete: true,
  status: 'available',
  channel: 'commentary',
  identity: native,
  content: firstContent,
  byteLength: Buffer.byteLength(firstContent, 'utf8'),
  source: {
    sessionId: summary.sessionId,
    invocationId: summary.invocationId,
    firstEventNo: 101,
    lastEventNo: 103,
    eventCount: 3,
  },
};

const event = (eventNo, payload) => ({
  v: 1,
  t: 1000 + eventNo,
  threadId: summary.threadId,
  catId: summary.catId,
  sessionId: summary.sessionId,
  invocationId: summary.invocationId,
  eventNo,
  event: payload,
});

export const detail = {
  invocationId: summary.invocationId,
  total: 124,
  summary,
  promptInput: {
    status: 'available',
    messages: [
      {
        messageId: 'fixture-trigger',
        status: 'available',
        author: 'user',
        excerpt: '请核对输入与工具结果。',
      },
      { messageId: 'fixture-deleted', status: 'deleted' },
    ],
  },
  events: [
    ...Array.from({ length: 100 }, (_, n) => event(n, { type: 'status', status: 'running' })),
    event(100, { type: 'user', content: '真实宿主中的合成触发消息。' }),
    event(101, {
      type: 'text',
      content: 'You，',
      outputMessage: { ...native, channel: 'commentary', complete: false, textMode: 'append' },
    }),
    event(102, {
      type: 'text',
      content: '这是一份中途快照',
      outputMessage: { ...native, channel: 'commentary', complete: false, textMode: 'append' },
    }),
    event(103, {
      type: 'text',
      content: firstContent,
      outputMessage: { ...native, channel: 'commentary', complete: true, textMode: 'replace' },
    }),
    event(104, {
      type: 'text',
      content: '\n\n保留角色颜色与原始记录。',
      outputMessage: {
        ...native,
        nativeId: 'final-message',
        channel: 'final',
        complete: true,
        textMode: 'replace',
        displayPrefixLength: 2,
      },
    }),
    event(102, { type: 'system', content: '系统记录仍可查。' }),
    event(103, { type: 'context', content: '上下文记录仍可查。' }),
    event(104, {
      type: 'tool_use',
      toolName: 'exec_command',
      toolUseId: 'known',
      toolSource: 'host_cli',
      toolChannel: 'commentary',
      toolInput: { command: 'read-only fixture' },
    }),
    event(105, { type: 'tool_result', toolUseId: 'known', toolResultStatus: 'error', content: '错误结果原文保留。' }),
    event(106, {
      type: 'tool_use',
      toolName: 'unknown_source',
      toolUseId: 'unknown',
      toolSource: 'unknown',
      toolChannel: 'unknown',
    }),
    ...Array.from({ length: 12 }, (_, n) =>
      event(107 + n, { type: 'tool_use', toolName: `tool_${n}`, toolSource: 'mcp', toolChannel: 'analysis' }),
    ),
    event(119, { type: 'error', error: '错误卡原文保留。' }),
    event(120, { type: 'done' }),
  ].map((envelope, eventNo) => ({ ...envelope, eventNo, t: 1000 + eventNo })),
};

export const exactInput = `${'实际提交的长文输入。\n'.repeat(180)}完整输入末尾标记`;
const digest = `hmac-sha256:${'a'.repeat(64)}`;
export function generations(reveal) {
  const channel = (kind, state, body) => ({
    channel: kind,
    accuracy: 'exact',
    keyedContentDigest: digest,
    byteLength: Buffer.byteLength(exactInput, 'utf8'),
    sourceRefs: [{ owner: 'message', ref: `${THREAD_ID}:fixture-trigger` }],
    state,
    ...(body === undefined ? {} : { body }),
  });
  return {
    invocationId: summary.invocationId,
    threadId: THREAD_ID,
    gaps: [],
    generations: [
      {
        envelope: {
          v: 1,
          invocationId: summary.invocationId,
          sessionId: summary.sessionId,
          generationOrdinal: 1,
          requestGenerationId: '00000000-0000-4000-8000-000000000001',
          promptGenerationId: digest,
          assembledAt: 1000,
          continuity: { capability: 'exact', mode: 'cold', contextEpoch: 1, compactionRefs: [] },
          channels: [
            channel('message', reveal ? 'available' : 'redacted', reveal ? exactInput : undefined),
            channel('native_instruction', 'deleted'),
            channel('provider_native_hidden', 'unknown'),
          ],
          presentations: [],
          runtime: {
            requested: { provider: 'openai', carrier: 'app_server', model: 'gpt-6.1-sol' },
            providerNativeVisibility: 'unknown',
          },
          tools: { finalSurface: 'exact', catCafeSchemaSetHash: digest },
          retryBoundary: { attempt: 1 },
        },
        observed: { evidence: { model: 'gpt-6.1-sol' } },
      },
    ],
  };
}

export const cats = [
  {
    id: 'codex61-sol',
    displayName: '小太阳',
    avatar: '/avatars/codex.png',
    color: { primary: '#5B8C5A', secondary: '#DCE7D8' },
    mentionPatterns: ['@codex61-sol'],
    carrier: 'cli',
    clientId: 'openai',
    defaultModel: 'gpt-6.1-sol',
  },
];
