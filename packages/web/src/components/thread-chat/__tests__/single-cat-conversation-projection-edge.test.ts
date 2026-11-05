import { describe, expect, it } from 'vitest';
import { projectSingleCatConversation } from '../single-cat-conversation-projection';
import {
  CAT_ID,
  executionAt,
  inputMessage,
  queueEntry,
  responseMessage,
  standaloneOutput,
} from './single-cat-conversation-fixtures';

describe('projectSingleCatConversation boundaries', () => {
  it('keeps queued and recovered inputs in one unconfirmed block and deduplicates by message id', () => {
    const oldResponse = responseMessage({ id: 'old-response', startedAt: 100, inputMessageIds: [] });
    const queued = inputMessage({ id: 'queued', timestamp: 300 });
    const recovered = inputMessage({ id: 'recovered', timestamp: 200 });
    const other = inputMessage({ id: 'other-cat', timestamp: 400 });

    const result = projectSingleCatConversation({
      catId: CAT_ID,
      messages: [queued, oldResponse, other, recovered],
      queue: [
        queueEntry('queued', [CAT_ID], 300),
        queueEntry('queued', [CAT_ID], 301, 'queue-queued-duplicate'),
        queueEntry('recovered', [CAT_ID], 200),
        queueEntry('other-cat', ['codex-sol'], 400),
      ],
    });

    const pending = result.blocks.at(-1);
    expect(pending).toMatchObject({ kind: 'pending-inputs' });
    if (pending?.kind !== 'pending-inputs') throw new Error('expected pending inputs');
    expect(pending.inputs.map((input) => [input.message.id, input.evidence, input.source])).toEqual([
      ['recovered', 'unconfirmed', 'queue'],
      ['queued', 'unconfirmed', 'queue'],
    ]);
  });

  it('includes each loaded source from a merged queue entry exactly once', () => {
    const first = inputMessage({ id: 'first', timestamp: 100 });
    const second = inputMessage({ id: 'second', timestamp: 200 });
    const merged = { ...queueEntry('first', [CAT_ID], 100), mergedMessageIds: ['second', 'first'] };

    const result = projectSingleCatConversation({ catId: CAT_ID, messages: [second, first], queue: [merged] });

    const pending = result.blocks[0];
    if (pending?.kind !== 'pending-inputs') throw new Error('expected pending inputs');
    expect(pending.inputs.map((input) => input.message.id)).toEqual(['first', 'second']);
  });

  it('sorts execution blocks by startedAt, keeps independent selected-cat output, and excludes other cats', () => {
    const later = responseMessage({ id: 'later', startedAt: 300 });
    const earlier = responseMessage({ id: 'earlier', startedAt: 100, timestamp: 900 });
    const own = standaloneOutput('own', CAT_ID, 200);
    const other = standaloneOutput('other', 'codex-sol', 150);

    const result = projectSingleCatConversation({ catId: CAT_ID, messages: [later, other, own, earlier], queue: [] });

    expect(
      result.blocks.map((block) => {
        if (block.kind === 'execution') return block.response.id;
        if (block.kind === 'standalone-output') return block.message.id;
        throw new Error('did not expect pending inputs');
      }),
    ).toEqual(['earlier', 'own', 'later']);
  });

  it('fails read proof closed when target dispatch refs are ambiguous but retains the admitted source as unconfirmed', () => {
    const response = responseMessage({ id: 'response-ambiguous', startedAt: 200, inputMessageIds: ['source'] });
    const source = inputMessage({
      id: 'source',
      timestamp: 100,
      dispatchRefs: [
        {
          targetId: CAT_ID,
          phase: 'settled',
          statusMessageId: response.id,
          dispatchedAt: 110,
          inputRead: { status: 'read', at: 120 },
        },
        {
          targetId: CAT_ID,
          phase: 'settled',
          statusMessageId: response.id,
          dispatchedAt: 111,
          inputRead: { status: 'read', at: 121 },
        },
      ],
    });

    const result = projectSingleCatConversation({ catId: CAT_ID, messages: [source, response], queue: [] });

    expect(executionAt(result.blocks).read).toEqual([]);
    expect(executionAt(result.blocks).unconfirmed).toEqual([['source', 'response']]);
  });

  it('does not use a stale public association when one exact ref points at another response', () => {
    const stale = responseMessage({ id: 'stale-response', startedAt: 100, inputMessageIds: ['source'] });
    const current = responseMessage({ id: 'current-response', startedAt: 200, inputMessageIds: [] });
    const source = inputMessage({
      id: 'source',
      timestamp: 50,
      dispatchRefs: [
        {
          targetId: CAT_ID,
          phase: 'settled',
          statusMessageId: current.id,
          dispatchedAt: 60,
          inputRead: { status: 'read', at: 70 },
        },
      ],
    });

    const result = projectSingleCatConversation({ catId: CAT_ID, messages: [source, stale, current], queue: [] });

    expect(executionAt(result.blocks, 0).read).toEqual([]);
    expect(executionAt(result.blocks, 0).unconfirmed).toEqual([]);
    expect(executionAt(result.blocks, 1).read).toEqual([]);
    expect(executionAt(result.blocks, 1).unconfirmed).toEqual([]);
  });

  it('does not invent a placeholder when a response references a source outside the loaded page', () => {
    const response = responseMessage({ id: 'response-cross-page', startedAt: 200, inputMessageIds: ['not-loaded'] });

    const result = projectSingleCatConversation({ catId: CAT_ID, messages: [response], queue: [] });

    expect(executionAt(result.blocks).read).toEqual([]);
    expect(executionAt(result.blocks).unconfirmed).toEqual([]);
  });

  it('fails duplicate message identities closed rather than displaying either body twice', () => {
    const first = responseMessage({ id: 'duplicate', startedAt: 100 });
    const second = { ...first, content: 'different canonical candidate', timestamp: 200 };

    const result = projectSingleCatConversation({ catId: CAT_ID, messages: [first, second], queue: [] });

    expect(result).toEqual({ blocks: [], hasEvidence: false });
  });

  it('fails duplicate standalone and mixed response identities closed', () => {
    const firstStandalone = standaloneOutput('duplicate-standalone', CAT_ID, 100);
    const secondStandalone = { ...firstStandalone, content: 'different standalone candidate', timestamp: 200 };
    const duplicateStandalone = projectSingleCatConversation({
      catId: CAT_ID,
      messages: [firstStandalone, secondStandalone],
      queue: [],
    });

    const response = responseMessage({ id: 'duplicate-mixed', startedAt: 300 });
    const unhydratedCopy = standaloneOutput('duplicate-mixed', CAT_ID, 301);
    const duplicateMixed = projectSingleCatConversation({
      catId: CAT_ID,
      messages: [response, unhydratedCopy],
      queue: [],
    });

    expect(duplicateStandalone).toEqual({ blocks: [], hasEvidence: false });
    expect(duplicateMixed).toEqual({ blocks: [], hasEvidence: false });
  });

  it('does not enable a view from a queue identity when its owner-visible body is not loaded', () => {
    const result = projectSingleCatConversation({
      catId: CAT_ID,
      messages: [],
      queue: [queueEntry('not-loaded', [CAT_ID], 100)],
    });

    expect(result).toEqual({ blocks: [], hasEvidence: false });
  });

  it('reports no provable projection for an unrelated participant', () => {
    const result = projectSingleCatConversation({
      catId: CAT_ID,
      messages: [standaloneOutput('other', 'codex-sol', 100), inputMessage({ id: 'user', timestamp: 90 })],
      queue: [queueEntry('user', ['codex-sol'], 90)],
    });

    expect(result).toEqual({ blocks: [], hasEvidence: false });
  });
});
