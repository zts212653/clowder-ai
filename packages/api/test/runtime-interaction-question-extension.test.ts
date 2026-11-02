/**
 * F306 Phase C — shared question interaction contract extension (iCode parity).
 *
 * iCode's ask-user semantics need two things the original contract could not
 * express: multi-select questions and per-question "may stay unanswered".
 * Both are additive/optional fields, so existing Codex-shaped records keep
 * parsing and Codex questions keep requiring an answer. These tests pin the
 * strictness boundary in both directions.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { parseRuntimeInteractionRequest, parseRuntimeInteractionResponse } = await import('@cat-cafe/shared');

const owner = { userId: 'user-1', threadId: 'thread-1', catId: 'opus', invocationId: 'inv-1' };
const provider = { providerId: 'chrys', method: '_chrys/request_input', requestId: 'ask-1' };

function questionRequest(questions) {
  return parseRuntimeInteractionRequest({
    version: 1,
    interactionId: 'ix-1',
    kind: 'question',
    owner,
    provider,
    createdAt: 1,
    title: 'iCode 需要你的回答',
    questions,
  });
}

describe('runtime interaction question contract — iCode parity extension', () => {
  it('accepts multiSelect and allowUnanswered as optional question fields', () => {
    const request = questionRequest([
      {
        id: 'q0',
        header: 'Topics',
        question: 'Which topics?',
        multiSelect: true,
        allowUnanswered: true,
        options: [{ label: 'A', description: 'alpha' }],
      },
      { id: 'q1', header: 'Note', question: 'Anything else?' },
    ]);
    assert.equal(request.questions[0].multiSelect, true);
    assert.equal(request.questions[0].allowUnanswered, true);
    assert.equal(request.questions[1].multiSelect, undefined);
    assert.equal(request.questions[1].allowUnanswered, undefined);
  });

  it('keeps legacy question records (no new fields) parseable', () => {
    const request = questionRequest([{ id: 'q0', header: 'H', question: 'Q?' }]);
    assert.equal(request.questions[0].id, 'q0');
  });

  it('still rejects unknown question fields (strict schema)', () => {
    assert.throws(() => questionRequest([{ id: 'q0', header: 'H', question: 'Q?', note: 'not-a-field' }]));
  });

  it('accepts multiple values for a multiSelect question', () => {
    const request = questionRequest([
      {
        id: 'q0',
        header: 'H',
        question: 'Q?',
        multiSelect: true,
        options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
      },
    ]);
    const response = parseRuntimeInteractionResponse(request, {
      kind: 'answers',
      answers: { q0: ['A', 'C'] },
    });
    assert.deepEqual(response, { kind: 'answers', answers: { q0: ['A', 'C'] } });
  });

  it('accepts an empty answer only when the question allows unanswered', () => {
    const optional = questionRequest([{ id: 'q0', header: 'H', question: 'Q?', allowUnanswered: true }]);
    assert.deepEqual(parseRuntimeInteractionResponse(optional, { kind: 'answers', answers: { q0: [] } }), {
      kind: 'answers',
      answers: { q0: [] },
    });

    const required = questionRequest([{ id: 'q0', header: 'H', question: 'Q?' }]);
    assert.throws(() => parseRuntimeInteractionResponse(required, { kind: 'answers', answers: { q0: [] } }));
  });

  it('keeps requiring every question id to be addressed', () => {
    const request = questionRequest([
      { id: 'q0', header: 'H', question: 'Q?', allowUnanswered: true },
      { id: 'q1', header: 'H2', question: 'Q2?', allowUnanswered: true },
    ]);
    assert.throws(() => parseRuntimeInteractionResponse(request, { kind: 'answers', answers: { q0: [] } }));
  });
});
