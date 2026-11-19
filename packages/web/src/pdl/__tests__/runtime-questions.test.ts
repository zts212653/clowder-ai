import type { RuntimeInteractionRecord } from '@cat-cafe/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { observeApiSessionOwner } from '@/utils/api-session-identity';
import { chatModels } from '../chat-models';
import {
  questionRows,
  readRuntimeRecord,
  runtimeAskView,
  runtimeFieldKey,
  runtimeResponse,
  submitRuntimeAnswers,
} from '../runtime-questions';
import { fixtureData, fixtureUi } from './chat-fixture';

const transport = vi.hoisted(() => ({ read: vi.fn(), post: vi.fn(), seed: vi.fn() }));
vi.mock('@/lib/approval-producer-read', () => ({ readApprovalProducerBody: transport.read }));
vi.mock('@/utils/api-client', () => ({ apiFetch: transport.post }));
vi.mock('@/lib/approval-result-read', () => ({
  approvalResultRead: { seedFacts: transport.seed, clearOwner: vi.fn() },
}));

function requestRecord(): RuntimeInteractionRecord & {
  request: Extract<RuntimeInteractionRecord['request'], { kind: 'question' }>;
} {
  return {
    request: {
      version: 1,
      kind: 'question',
      interactionId: 'question-1',
      owner: { userId: 'owner-1', threadId: 'pdl-test', catId: 'codex', invocationId: 'turn-1' },
      provider: { providerId: 'codex', method: 'question', requestId: 'request-1' },
      createdAt: 1793664000000,
      title: '确认参数',
      questions: [{ id: 'q.1', header: '参数', question: '填写参数', isSecret: true }],
    },
    source: { kind: 'provider_request', provider: { providerId: 'codex', method: 'question', requestId: 'request-1' } },
    returnBinding: { kind: 'provider_waiter' },
    status: 'pending',
    hostEpoch: 'host-1',
    revision: 1,
    cardRef: { threadId: 'pdl-test', messageId: 'reply-1', blockId: 'block-1' },
    updatedAt: 1793664000000,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  observeApiSessionOwner('owner-1');
  transport.read.mockResolvedValue({ interaction: requestRecord() });
  transport.post.mockResolvedValue({ ok: true });
});

describe('canonical runtime question binding', () => {
  it('rejects a record owned by a different session', async () => {
    const record = requestRecord();
    transport.read.mockResolvedValue({
      interaction: {
        ...record,
        request: { ...record.request, owner: { ...record.request.owner, userId: 'other-owner' } },
      },
    });
    await expect(readRuntimeRecord('question-1')).rejects.toThrow('请求状态不可用');
  });

  it('re-reads and checks the exact published message/block before sending an answer', async () => {
    await expect(
      submitRuntimeAnswers(
        'question-1',
        { threadId: 'pdl-test', messageId: 'reply-1', blockId: 'different-block' },
        { 'q.1': ['value'] },
      ),
    ).rejects.toThrow('请求已变化');
    expect(transport.post).not.toHaveBeenCalled();
    await submitRuntimeAnswers(
      'question-1',
      { threadId: 'pdl-test', messageId: 'reply-1', blockId: 'block-1' },
      { 'q.1': ['value'] },
    );
    expect(transport.read).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'owner-1' }),
      '/api/runtime-interactions/question-1',
      expect.objectContaining({ fresh: true }),
    );
    const [path, options] = transport.post.mock.calls[0];
    expect(path).toBe('/api/runtime-interactions/question-1/respond');
    expect(JSON.parse(options.body)).toEqual({
      cardRef: requestRecord().cardRef,
      response: { kind: 'answers', answers: { 'q.1': ['value'] } },
    });
  });

  it('keeps unanswerable/closed requests out of the write path and returns a bounded input error', async () => {
    await expect(
      submitRuntimeAnswers('question-1', { threadId: 'pdl-test', messageId: 'reply-1', blockId: 'block-1' }, {}),
    ).rejects.toThrow('请检查必填回答');
    transport.read.mockResolvedValue({ interaction: { ...requestRecord(), status: 'answered' } });
    await expect(
      submitRuntimeAnswers(
        'question-1',
        { threadId: 'pdl-test', messageId: 'reply-1', blockId: 'block-1' },
        { 'q.1': ['value'] },
      ),
    ).rejects.toThrow('请求已变化');
    expect(transport.post).not.toHaveBeenCalled();
  });

  it('converts form primitives only at submission and uses the real elicitation decision contract', async () => {
    const base = requestRecord();
    const record = {
      ...base,
      request: {
        version: 1,
        interactionId: base.request.interactionId,
        owner: base.request.owner,
        provider: base.request.provider,
        createdAt: base.request.createdAt,
        title: base.request.title,
        kind: 'elicitation',
        mode: 'form',
        message: '填写配置',
        requestedSchema: {
          type: 'object',
          properties: { count: { type: 'integer', minimum: 1 }, enabled: { type: 'boolean' } },
          required: ['count', 'enabled'],
          additionalProperties: false,
        },
        decisions: [{ id: 'accept', label: '同意', outcome: 'accept' }],
      },
    } as RuntimeInteractionRecord;
    transport.read.mockResolvedValue({ interaction: record });
    const rows = questionRows(record, 'reply-1', {});
    expect(rows).toEqual([]); // r110: forms use fields + decisions, never ASK_QS.
    const draft = { count: '3', enabled: false };
    const vm = runtimeAskView({ record, current: true, refresh: async () => undefined }, 'reply-1', {}, draft);
    expect(vm).toMatchObject({
      qs: null,
      decisions: [{ v: 'accept' }],
      fields: [
        { key: 'count', type: 'integer', value: '3' },
        { key: 'enabled', type: 'boolean', value: false },
      ],
    });
    await submitRuntimeAnswers(
      'question-1',
      { threadId: 'pdl-test', messageId: 'reply-1', blockId: 'block-1' },
      {},
      {
        expected: record,
        operationId: 'test',
        response: runtimeResponse(record, 'reply-1', {}, 'accept', 'ask', draft),
      },
    );
    expect(JSON.parse(transport.post.mock.calls[0][1].body).response).toEqual({
      kind: 'decision',
      decisionId: 'accept',
      content: { count: 3, enabled: false },
    });
    transport.post.mockClear();
    expect(() => runtimeResponse(record, 'reply-1', {}, 'accept', 'ask', { ...draft, count: 'invalid' })).toThrow();
    expect(transport.post).not.toHaveBeenCalled();
  });

  it('projects external authorization and conversation decisions into the same ask contract', () => {
    const base = requestRecord();
    const common = {
      version: 1 as const,
      interactionId: base.request.interactionId,
      owner: base.request.owner,
      provider: base.request.provider,
      createdAt: base.request.createdAt,
      title: '授权',
    };
    const urlRecord = {
      ...base,
      request: {
        ...common,
        kind: 'elicitation' as const,
        mode: 'url' as const,
        message: '在外部完成',
        url: 'https://authorization.test/consent',
        elicitationId: 'authorize-1',
        decisions: [{ id: 'done', label: '已完成', outcome: 'accept' as const }],
      },
    } as RuntimeInteractionRecord;
    const authorization = runtimeAskView(
      { record: urlRecord, current: true, refresh: async () => undefined },
      'reply-1',
      {},
    );
    expect(authorization).toMatchObject({
      qs: null,
      url: 'https://authorization.test/consent',
      decisions: [{ v: 'done' }],
    });
    const record = {
      ...base,
      request: {
        ...common,
        kind: 'conversation_decision',
        presentation: {
          v: 1,
          id: 'choice',
          kind: 'interactive',
          interactiveType: 'multi-select',
          options: [
            { id: 'a', label: 'A' },
            { id: 'custom', label: '其它', customInput: true },
          ],
        },
        allowTextResponse: true,
      },
    } as RuntimeInteractionRecord;
    const draft = {
      [runtimeFieldKey(common.interactionId, 'selected')]: ['a', 'custom'],
      [runtimeFieldKey(common.interactionId, 'custom')]: 'private typed input',
    };
    const vm = runtimeAskView({ record, current: true, refresh: async () => undefined }, 'reply-1', draft);
    expect(vm).toMatchObject({
      qs: null,
      interactiveType: 'multi-select',
      canCustom: true,
      allowText: true,
      choices: [
        { v: 'a', on: true },
        { v: 'custom', on: true },
      ],
    });
    expect(runtimeResponse(record, 'reply-1', draft)).toMatchObject({
      kind: 'selection',
      selectedIds: ['a', 'custom'],
      customInput: 'private typed input',
    });
    const terminal = {
      ...record,
      status: 'cancelled',
      terminal: { status: 'cancelled', reasonCode: 'user_cancelled', settledAt: 1 },
    } as RuntimeInteractionRecord;
    expect(
      JSON.stringify(
        runtimeAskView({ record: terminal, current: true, refresh: async () => undefined }, 'reply-1', draft),
      ),
    ).not.toContain('private typed input');
  });

  it('encodes opaque question ids in state paths and never returns private answers in terminal VMs', () => {
    const record = requestRecord();
    const rows = questionRows(record, 'reply.1', {});
    expect(rows[0].group).not.toContain('.');
    expect(rows[0].secret).toBe(true);
    const data = fixtureData();
    data.messages[1].extra = {
      runtimeInteractionCard: { version: 1, interactionId: 'question-1', blockId: 'block-1', requestKind: 'question' },
    };
    const terminal: RuntimeInteractionRecord = {
      ...record,
      status: 'answered',
      terminal: {
        status: 'answered',
        reasonCode: 'answered',
        settledAt: 1793664001000,
        response: { kind: 'answers', answeredQuestionIds: ['q.1'], secretQuestionIds: ['q.1'] },
      },
      submission: {
        author: 'owner',
        operationId: 'op-1',
        responseDigest: 'digest-1',
        claimedAt: 1793664001000,
        response: { kind: 'answers', answers: { 'q.1': ['private-fixture-value'] } },
        terminal: { status: 'answered', reasonCode: 'answered', settledAt: 1793664001000 },
      },
    };
    data.questions = { 'question-1': { record: terminal, current: true, refresh: async () => undefined } };
    const vm = chatModels(data, fixtureUi());
    expect(vm.chatStream.items[1].kind).toBe('ask');
    expect(vm.chatStream.items[1].card).toHaveProperty('qs', null);
    expect(JSON.stringify(vm)).not.toContain('private-fixture-value');
  });
});
