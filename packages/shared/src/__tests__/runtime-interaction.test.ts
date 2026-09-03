import { describe, expect, it } from 'vitest';
import {
  parseRuntimeInteractionRequest,
  parseRuntimeInteractionResponse,
  type RuntimeInteractionRequest,
  redactRuntimeInteractionResponse,
} from '../types/runtime-interaction.js';

const owner = {
  userId: 'user-1',
  threadId: 'thread-1',
  catId: 'codex-sol',
  invocationId: 'inv-1',
} as const;

const provider = {
  providerId: 'openai',
  method: 'item/commandExecution/requestApproval',
  requestId: 'rpc-42',
  threadId: 'provider-thread',
  turnId: 'provider-turn',
  itemId: 'provider-item',
} as const;

function approvalRequest(): RuntimeInteractionRequest {
  return {
    version: 1,
    interactionId: 'interaction-1',
    kind: 'approval',
    owner,
    provider,
    createdAt: 1_777_000_000_000,
    title: 'Run command?',
    description: 'pnpm test',
    decisions: [
      { id: 'accept', label: 'Allow once', outcome: 'accept' },
      { id: 'decline', label: 'Decline', outcome: 'decline' },
      { id: 'cancel', label: 'Cancel turn', outcome: 'cancel' },
    ],
  };
}

describe('runtime interaction contract', () => {
  it('preserves an explicit producer-owned entrusted Task link', () => {
    const request = approvalRequest();
    const parsed = parseRuntimeInteractionRequest({
      ...request,
      entrustedWorkTaskRef: {
        subjectRef: 'task:work:tomorrows-ppt',
        observedRevision: 7,
      },
    });

    expect(parsed.entrustedWorkTaskRef).toEqual({
      subjectRef: 'task:work:tomorrows-ppt',
      observedRevision: 7,
    });
    expect(() =>
      parseRuntimeInteractionRequest({
        ...request,
        entrustedWorkTaskRef: {
          subjectRef: '',
          observedRevision: 0,
        },
      }),
    ).toThrow();
  });

  it('admits approval, multi-question, and MCP elicitation through one provider-neutral request union', () => {
    const approval = parseRuntimeInteractionRequest(approvalRequest());
    expect(approval.kind).toBe('approval');

    const question = parseRuntimeInteractionRequest({
      version: 1,
      interactionId: 'interaction-2',
      kind: 'question',
      owner,
      provider: { ...provider, method: 'item/tool/requestUserInput', requestId: 'rpc-43' },
      createdAt: 1_777_000_000_001,
      title: 'Need two answers',
      questions: [
        {
          id: 'environment',
          header: 'Environment',
          question: 'Where should this run?',
          options: [{ label: 'Alpha', description: 'Use isolated Alpha' }],
        },
        {
          id: 'token',
          header: 'Token',
          question: 'Provide the one-time token',
          isSecret: true,
        },
      ],
    });
    expect(question.kind).toBe('question');

    const elicitation = parseRuntimeInteractionRequest({
      version: 1,
      interactionId: 'interaction-3',
      kind: 'elicitation',
      owner,
      provider: { ...provider, method: 'mcpServer/elicitation/request', requestId: 'rpc-44' },
      createdAt: 1_777_000_000_002,
      title: 'Configure deployment',
      mode: 'form',
      message: 'Choose the target',
      requestedSchema: {
        type: 'object',
        properties: {
          region: { type: 'string', title: 'Region', enum: ['us-west', 'us-east'] },
          replicas: { type: 'integer', title: 'Replicas', minimum: 1 },
          dryRun: { type: 'boolean', title: 'Dry run' },
        },
        required: ['region', 'replicas'],
        additionalProperties: false,
      },
      decisions: [
        { id: 'accept', label: 'Submit', outcome: 'accept' },
        { id: 'decline', label: 'Decline', outcome: 'decline' },
        { id: 'cancel', label: 'Cancel', outcome: 'cancel' },
      ],
    });
    expect(elicitation.kind).toBe('elicitation');
  });

  it('preserves exact Clowder AI and provider request identity without requiring Codex-specific types', () => {
    const parsed = parseRuntimeInteractionRequest(approvalRequest());
    expect(parsed.owner).toEqual(owner);
    expect(parsed.provider).toEqual(provider);

    const nonCodex = parseRuntimeInteractionRequest({
      ...approvalRequest(),
      interactionId: 'interaction-anthropic',
      owner: { ...owner, catId: 'opus' },
      provider: {
        providerId: 'anthropic',
        method: 'host/confirmToolUse',
        requestId: 'anthropic-request-1',
        threadId: 'claude-session',
        turnId: 'claude-turn',
        itemId: 'tool-use-1',
      },
    });
    expect(nonCodex.provider.providerId).toBe('anthropic');
    expect(nonCodex.kind).toBe('approval');
  });

  it('rejects duplicate decision ids and unsupported elicitation schema shapes', () => {
    expect(() =>
      parseRuntimeInteractionRequest({
        ...approvalRequest(),
        decisions: [
          { id: 'same', label: 'Allow', outcome: 'accept' },
          { id: 'same', label: 'Decline', outcome: 'decline' },
        ],
      }),
    ).toThrow(/decision/i);

    expect(() =>
      parseRuntimeInteractionRequest({
        version: 1,
        interactionId: 'interaction-unsafe-schema',
        kind: 'elicitation',
        owner,
        provider,
        createdAt: 1_777_000_000_003,
        title: 'Unsafe schema',
        mode: 'form',
        message: 'Nested objects are not admitted in Phase B',
        requestedSchema: {
          type: 'object',
          properties: { nested: { type: 'object', properties: { value: { type: 'string' } } } },
        },
        decisions: [{ id: 'accept', label: 'Submit', outcome: 'accept' }],
      }),
    ).toThrow(/schema|property|type/i);
  });

  it('rejects elicitation defaults and enum values that disagree with the declared primitive type', () => {
    const formRequest = {
      version: 1,
      interactionId: 'interaction-invalid-primitive-schema',
      kind: 'elicitation',
      owner,
      provider,
      createdAt: 1_777_000_000_003,
      title: 'Typed schema',
      mode: 'form',
      message: 'Choose typed values',
      decisions: [{ id: 'accept', label: 'Submit', outcome: 'accept' }],
    } as const;

    expect(() =>
      parseRuntimeInteractionRequest({
        ...formRequest,
        requestedSchema: {
          type: 'object',
          properties: { enabled: { type: 'boolean', default: 'false' } },
          additionalProperties: false,
        },
      }),
    ).toThrow(/default|boolean|type/i);

    expect(() =>
      parseRuntimeInteractionRequest({
        ...formRequest,
        requestedSchema: {
          type: 'object',
          properties: { replicas: { type: 'integer', enum: [1, 1.5] } },
          additionalProperties: false,
        },
      }),
    ).toThrow(/enum|integer|type/i);
  });

  it('admits only http and https URL elicitation targets', () => {
    const request = {
      version: 1,
      interactionId: 'interaction-url-scheme',
      kind: 'elicitation',
      owner,
      provider,
      createdAt: 1_777_000_000_004,
      title: 'Authorize provider',
      mode: 'url',
      message: 'Complete authorization in the provider page.',
      elicitationId: 'elicitation-url-scheme',
      decisions: [{ id: 'accept', label: 'Done', outcome: 'accept' }],
    } as const;

    for (const url of ['https://example.com/authorize', 'http://localhost:4111/callback']) {
      const parsed = parseRuntimeInteractionRequest({ ...request, url });
      if (parsed.kind !== 'elicitation' || parsed.mode !== 'url') throw new Error('expected URL elicitation');
      expect(parsed.url).toBe(url);
    }
    for (const url of ['javascript:alert(1)', 'data:text/html,<h1>unsafe</h1>', 'file:///etc/passwd']) {
      expect(() => parseRuntimeInteractionRequest({ ...request, url })).toThrow(/http|https|url/i);
    }
  });

  it('validates a response against the exact request decisions and question ids', () => {
    const approval = approvalRequest();
    expect(parseRuntimeInteractionResponse(approval, { kind: 'decision', decisionId: 'accept' })).toEqual({
      kind: 'decision',
      decisionId: 'accept',
    });
    expect(() =>
      parseRuntimeInteractionResponse(approval, { kind: 'decision', decisionId: 'acceptForSession' }),
    ).toThrow(/decision/i);

    const question = parseRuntimeInteractionRequest({
      version: 1,
      interactionId: 'interaction-questions',
      kind: 'question',
      owner,
      provider,
      createdAt: 1_777_000_000_004,
      title: 'Questions',
      questions: [
        { id: 'environment', header: 'Environment', question: 'Where?' },
        { id: 'token', header: 'Token', question: 'Token?', isSecret: true },
      ],
    });
    expect(
      parseRuntimeInteractionResponse(question, {
        kind: 'answers',
        answers: { environment: ['Alpha'], token: ['secret-value'] },
      }),
    ).toEqual({ kind: 'answers', answers: { environment: ['Alpha'], token: ['secret-value'] } });
    expect(() =>
      parseRuntimeInteractionResponse(question, { kind: 'answers', answers: { environment: ['Alpha'] } }),
    ).toThrow(/token|question/i);
  });

  it('redacts every answer value while retaining field-level terminal truth', () => {
    const question = parseRuntimeInteractionRequest({
      version: 1,
      interactionId: 'interaction-secret',
      kind: 'question',
      owner,
      provider,
      createdAt: 1_777_000_000_005,
      title: 'Secrets',
      questions: [
        { id: 'visible', header: 'Visible', question: 'Visible answer?' },
        { id: 'secret', header: 'Secret', question: 'Secret answer?', isSecret: true },
      ],
    });
    const response = parseRuntimeInteractionResponse(question, {
      kind: 'answers',
      answers: { visible: ['ordinary-value'], secret: ['super-secret-value'] },
    });
    const redacted = redactRuntimeInteractionResponse(question, response);

    expect(redacted).toEqual({
      kind: 'answers',
      answeredQuestionIds: ['visible', 'secret'],
      secretQuestionIds: ['secret'],
    });
    expect(JSON.stringify(redacted)).not.toContain('ordinary-value');
    expect(JSON.stringify(redacted)).not.toContain('super-secret-value');
  });
});
