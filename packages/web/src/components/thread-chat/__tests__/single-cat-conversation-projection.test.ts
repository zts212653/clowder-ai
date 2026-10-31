import { describe, expect, it } from 'vitest';
import { projectSingleCatConversation } from '../single-cat-conversation-projection';
import {
  CAT_ID,
  executionAt,
  inputMessage,
  markInputRead,
  responseMessage,
  standaloneOutput,
} from './single-cat-conversation-fixtures';

describe('projectSingleCatConversation execution evidence', () => {
  it('groups exact inputs under the selected cat response and separates confirmed reads from unknowns', () => {
    const response = responseMessage({
      id: 'response-1',
      startedAt: 200,
      timestamp: 900,
      inputMessageIds: ['read', 'unknown'],
    });
    const read = inputMessage({
      id: 'read',
      timestamp: 800,
      dispatchRefs: [
        {
          targetId: CAT_ID,
          phase: 'settled',
          statusMessageId: response.id,
          dispatchedAt: 70,
          inputRead: { status: 'read', at: 80 },
        },
      ],
    });
    const unknown = inputMessage({
      id: 'unknown',
      timestamp: 10,
      from: { kind: 'agent', catId: 'codex-sol' },
      dispatchRefs: [
        {
          targetId: CAT_ID,
          phase: 'settled',
          statusMessageId: response.id,
          dispatchedAt: 90,
          inputRead: { status: 'pending' },
        },
      ],
    });
    const unrelated = inputMessage({ id: 'unrelated', timestamp: 20 });
    const laterOwnOutput = standaloneOutput('standalone', CAT_ID, 300);

    const result = projectSingleCatConversation({
      catId: CAT_ID,
      messages: [unrelated, unknown, response, read, laterOwnOutput],
      queue: [],
    });

    expect(result.hasEvidence).toBe(true);
    expect(result.blocks).toHaveLength(2);
    expect(executionAt(result.blocks)).toEqual({
      response: 'response-1',
      startedAt: 200,
      invocationId: 'invocation-response-1',
      read: [['read', 80, 'response']],
      unconfirmed: [['unknown', 'response']],
    });
    expect(result.blocks[1]).toMatchObject({ kind: 'standalone-output', message: { id: 'standalone' } });
  });

  it('orders confirmations by inputRead.at and preserves admission order when timestamps tie', () => {
    const response = responseMessage({
      id: 'response-order',
      startedAt: 500,
      inputMessageIds: ['late', 'tie-a', 'early', 'tie-b'],
    });
    const read = (id: string, timestamp: number, at: number) =>
      inputMessage({
        id,
        timestamp,
        dispatchRefs: [
          {
            targetId: CAT_ID,
            phase: 'settled',
            statusMessageId: response.id,
            dispatchedAt: 1,
            inputRead: { status: 'read', at },
          },
        ],
      });

    const result = projectSingleCatConversation({
      catId: CAT_ID,
      messages: [
        read('early', 900, 100),
        read('tie-b', 1, 200),
        response,
        read('late', 2, 300),
        read('tie-a', 800, 200),
      ],
      queue: [],
    });

    expect(executionAt(result.blocks).read.map(([id]) => id)).toEqual(['early', 'tie-a', 'tie-b', 'late']);
  });

  it('updates one source from unconfirmed to read when late evidence arrives without duplicating it', () => {
    const response = responseMessage({ id: 'response-late', startedAt: 200, inputMessageIds: ['source'] });
    const source = inputMessage({
      id: 'source',
      timestamp: 100,
      dispatchRefs: [
        {
          targetId: CAT_ID,
          phase: 'settled',
          statusMessageId: response.id,
          dispatchedAt: 120,
          inputRead: { status: 'pending' },
        },
      ],
    });
    const before = projectSingleCatConversation({ catId: CAT_ID, messages: [source, response], queue: [] });
    const after = projectSingleCatConversation({
      catId: CAT_ID,
      messages: [markInputRead(source, 160), response],
      queue: [],
    });

    expect(executionAt(before.blocks).unconfirmed).toEqual([['source', 'response']]);
    expect(executionAt(after.blocks).read).toEqual([['source', 160, 'response']]);
    expect(executionAt(after.blocks).unconfirmed).toEqual([]);
  });

  it('reverse-links a visible whisper by its exact dispatchRef without publishing it through inputMessageIds', () => {
    const response = responseMessage({ id: 'response-private', startedAt: 300, inputMessageIds: [] });
    const whisper = inputMessage({
      id: 'whisper',
      timestamp: 200,
      visibility: 'whisper',
      dispatchRefs: [
        {
          targetId: CAT_ID,
          phase: 'settled',
          statusMessageId: response.id,
          dispatchedAt: 220,
          inputRead: { status: 'read', at: 240 },
        },
      ],
    });
    const ordinary = inputMessage({
      id: 'ordinary-not-admitted',
      timestamp: 210,
      dispatchRefs: [
        {
          targetId: CAT_ID,
          phase: 'settled',
          statusMessageId: response.id,
          dispatchedAt: 230,
          inputRead: { status: 'read', at: 250 },
        },
      ],
    });

    const result = projectSingleCatConversation({ catId: CAT_ID, messages: [whisper, ordinary, response], queue: [] });

    expect(executionAt(result.blocks).read).toEqual([['whisper', 240, 'whisper']]);
  });
});
