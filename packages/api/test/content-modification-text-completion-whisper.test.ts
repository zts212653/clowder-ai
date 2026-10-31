import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { signEditToken } from '../src/domains/workspace/workspace-edit.js';
import { firstFileFixture } from './helpers/content-modification-first-file-fixture.js';

test('a real whispered Human takeover keeps its exact private audience in the separate owner completion', async (t) => {
  const f = await firstFileFixture(t);
  const human = f.messages.append({
    userId: 'operator',
    threadId: f.thread.id,
    from: { kind: 'user', userId: 'operator' },
    mentions: ['codex-astra'],
    visibility: 'whisper',
    whisperTo: ['codex-astra'],
    timestamp: Date.now(),
    content: 'Please revise this private passage.',
    contentBlocks: [f.block()],
  });
  const taken = await f.takeover(human.id, randomUUID());
  assert.equal(taken.statusCode, 200, taken.body);
  const record = f.store.requests.get(taken.json().record.requestId, 'operator')!;
  assert.deepEqual(record.progress.sourceVisibility, { visibility: 'whisper', whisperTo: ['codex-astra'] });
  const source = await f.integration.text.read(record.requestId, f.cat);
  const start = source.source.text.indexOf('First unique');
  const returned = await f.integration.text.respond(
    {
      requestId: record.requestId,
      operationId: randomUUID(),
      expectedTaskRevision: record.progress.task!.revision,
      expectedProposalRevision: 0,
      baseRevision: source.source.source.revision,
      edits: [
        { start, end: start + 'First unique'.length, expectedText: 'First unique', replacement: 'Private changed' },
      ],
      response: 'The private passage is revised.',
    },
    f.cat,
  );
  await f.dispatch.close();
  const accepted = await f.integration.results.accept(
    {
      requestId: record.requestId,
      candidateRef: returned.proposal.proposalRef,
      acceptOperationId: randomUUID(),
      baseRevision: source.source.source.revision,
      locator: f.locator,
      editSessionToken: signEditToken('worktree-a'),
    },
    f.human,
  );
  assert.equal(accepted.receipt.state, 'applied');
  const completions = f.messages
    .getByThreadIncludingQueued(f.thread.id)
    .filter((message) => message.source?.meta?.kind === 'text_writeback_completion');
  assert.equal(completions.length, 1);
  assert.equal(completions[0]!.visibility, 'whisper');
  assert.deepEqual(completions[0]!.whisperTo, ['codex-astra']);
  assert.equal(completions[0]!.source!.meta!.sourceMessageId, human.id);
  assert.equal(
    completions[0]!.content.includes('Please revise this private passage.'),
    false,
    'return body carries refs, not copied Human text',
  );
  const display = f.messages
    .getByThreadIncludingQueued(f.thread.id)
    .find((m) => m.extra?.contentModificationReceiptV1?.state === 'applied');
  assert.equal(display?.visibility, 'whisper');
  assert.deepEqual(display?.extra?.contentModificationReceiptV1?.followUp, { kind: 'none', reason: 'not_applicable' });
});
