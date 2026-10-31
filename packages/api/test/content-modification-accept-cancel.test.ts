import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { signEditToken } from '../src/domains/workspace/workspace-edit.js';
import { cancellationFixture as fixture } from './helpers/content-modification-cancellation-fixture.js';

test('the same prior acceptance can recover a crash before the F063 write after its own request cancellation', async (t) => {
  const f = await fixture(t);
  const request = await f.integration.requests.submit(f.payload, f.human),
    source = await f.integration.text.read(f.requestId, f.cat);
  const returned = await f.integration.text.respond(
    {
      requestId: f.requestId,
      operationId: randomUUID(),
      expectedTaskRevision: request.record.progress.task!.revision,
      expectedProposalRevision: 0,
      baseRevision: source.source.source.revision,
      edits: [{ start: 4, end: 7, expectedText: 'old', replacement: 'new' }],
      response: '已更新',
    },
    f.cat,
  );
  const write = f.integration.writer.accept.bind(f.integration.writer);
  f.integration.writer.accept = async () => {
    throw new Error('crash before F063 intent');
  };
  const command = {
    requestId: f.requestId,
    candidateRef: returned.proposal.proposalRef,
    acceptOperationId: randomUUID(),
    baseRevision: source.source.source.revision,
    locator: f.payload.source.locator,
    editSessionToken: signEditToken('work'),
  };
  await assert.rejects(f.integration.results.accept(command, f.human), /crash before F063/);
  assert.equal(f.store.acceptances.list(f.requestId, 'operator').length, 1);
  await f.cancel();
  assert.equal(await readFile(join(f.root, 'guide.md'), 'utf8'), 'The old text.');
  f.integration.writer.accept = write;
  assert.equal((await f.integration.results.accept(command, f.human)).receipt.state, 'applied');
  assert.equal(await readFile(join(f.root, 'guide.md'), 'utf8'), 'The new text.');
  await assert.rejects(
    f.integration.results.accept({ ...command, acceptOperationId: randomUUID() }, f.human),
    /request_cancelled/,
  );
});

test('cancel wins against a candidate still being read before the human acceptance is recorded', async (t) => {
  const f = await fixture(t);
  const request = await f.integration.requests.submit(f.payload, f.human),
    source = await f.integration.text.read(f.requestId, f.cat);
  const returned = await f.integration.text.respond(
    {
      requestId: f.requestId,
      operationId: randomUUID(),
      expectedTaskRevision: request.record.progress.task!.revision,
      expectedProposalRevision: 0,
      baseRevision: source.source.source.revision,
      edits: [{ start: 4, end: 7, expectedText: 'old', replacement: 'new' }],
      response: '已更新',
    },
    f.cat,
  );
  const candidate = f.integration.text.candidate.bind(f.integration.text);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
      enter = resolve;
    }),
    blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
  f.integration.text.candidate = async (...args) => {
    const result = await candidate(...args);
    enter();
    await blocked;
    return result;
  };
  const accepting = f.integration.results.accept(
    {
      requestId: f.requestId,
      candidateRef: returned.proposal.proposalRef,
      acceptOperationId: randomUUID(),
      baseRevision: source.source.source.revision,
      locator: f.payload.source.locator,
      editSessionToken: signEditToken('work'),
    },
    f.human,
  );
  const rejected = assert.rejects(accepting, /request_cancelled/);
  await entered;
  await f.cancel();
  release();
  await rejected;
  assert.equal(await readFile(join(f.root, 'guide.md'), 'utf8'), 'The old text.');
  assert.equal(f.store.acceptances.list(f.requestId, 'operator').length, 0);
});

test('an acceptance recorded before cancel retains its actual write receipt and is not rolled back or written twice', async (t) => {
  const f = await fixture(t);
  const request = await f.integration.requests.submit(f.payload, f.human),
    source = await f.integration.text.read(f.requestId, f.cat);
  const returned = await f.integration.text.respond(
    {
      requestId: f.requestId,
      operationId: randomUUID(),
      expectedTaskRevision: request.record.progress.task!.revision,
      expectedProposalRevision: 0,
      baseRevision: source.source.source.revision,
      edits: [{ start: 4, end: 7, expectedText: 'old', replacement: 'new' }],
      response: '已更新',
    },
    f.cat,
  );
  const write = f.integration.writer.accept.bind(f.integration.writer);
  let enter!: () => void,
    release!: () => void,
    writes = 0;
  const entered = new Promise<void>((resolve) => {
      enter = resolve;
    }),
    blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
  f.integration.writer.accept = async (...args) => {
    writes += 1;
    enter();
    await blocked;
    return write(...args);
  };
  const command = {
    requestId: f.requestId,
    candidateRef: returned.proposal.proposalRef,
    acceptOperationId: randomUUID(),
    baseRevision: source.source.source.revision,
    locator: f.payload.source.locator,
    editSessionToken: signEditToken('work'),
  };
  const accepting = f.integration.results.accept(command, f.human);
  await entered;
  assert.equal(f.store.acceptances.list(f.requestId, 'operator').length, 1);
  await f.cancel();
  release();
  const applied = await accepting;
  assert.equal(applied.receipt.state, 'applied');
  assert.equal(await readFile(join(f.root, 'guide.md'), 'utf8'), 'The new text.');
  assert.equal((await f.integration.results.accept(command, f.human)).receipt.state, 'applied');
  assert.equal(writes, 1);
});
