import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import Database from 'better-sqlite3';
import { ContentAcceptanceStore } from '../src/domains/collaborative-content/modification/acceptance-store.js';
import { inspectContentModification } from '../src/domains/collaborative-content/modification/inspection.js';
import { signEditToken } from '../src/domains/workspace/workspace-edit.js';
import { cancellationFixture } from './helpers/content-modification-cancellation-fixture.js';

async function candidateFixture(t: TestContext) {
  const f = await cancellationFixture(t);
  const request = await f.integration.requests.submit(f.payload, f.human);
  const source = await f.integration.text.read(f.requestId, f.cat);
  const response = {
    requestId: f.requestId,
    operationId: randomUUID(),
    expectedTaskRevision: request.record.progress.task!.revision,
    expectedProposalRevision: 0,
    baseRevision: source.source.source.revision,
    edits: [{ start: 4, end: 7, expectedText: 'old', replacement: 'new' }],
    response: '新版供审阅',
  };
  const returned = await f.integration.text.respond(response, f.cat);
  const command = {
    requestId: f.requestId,
    candidateRef: returned.proposal.proposalRef,
    acceptOperationId: randomUUID(),
    baseRevision: source.source.source.revision,
    locator: f.payload.source.locator,
    editSessionToken: signEditToken('work'),
  };
  const reject = () =>
    f.app.inject({
      method: 'POST',
      url: `/api/content-modifications/${f.requestId}/reject`,
      headers: { 'x-cat-cafe-user': 'operator' },
      payload: { candidateRef: command.candidateRef },
    });
  return { ...f, request, response, command, reject };
}

test('rejecting a candidate keeps the original file and Task, persists the human decision, and allows another candidate', async (t) => {
  const f = await candidateFixture(t);
  const before = (await f.catRead()).json();
  const first = await f.reject();
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().actorId, 'operator');
  assert.deepEqual((await f.reject()).json(), first.json());
  assert.equal(
    f.store.requests.get(f.requestId, 'operator')?.revision,
    f.request.record.revision + 1,
    'one human decision advances the delayed-read fence exactly once',
  );
  const secondConnection = new Database(join(f.root, 'collaborative-content', 'artifact-reviews.sqlite'));
  try {
    assert.deepEqual(new ContentAcceptanceStore(secondConnection).rejections(f.requestId, 'operator'), [first.json()]);
  } finally {
    secondConnection.close();
  }
  assert.equal(await readFile(join(f.root, 'guide.md'), 'utf8'), 'The old text.');
  assert.equal((await f.tasks.get(f.request.record.progress.task!.taskId))?.entrustedWork?.closure.state, 'open');
  await assert.rejects(f.integration.results.accept(f.command, f.human), /candidate_rejected/);
  const detail = await f.app.inject({
    url: `/api/content-modifications/${f.requestId}`,
    headers: { 'x-cat-cafe-user': 'operator' },
  });
  assert.equal(detail.json().candidates.length, 1);
  assert.deepEqual(detail.json().rejections, [first.json()]);
  const catView = JSON.parse((await f.catRead()).json().json);
  assert.deepEqual(catView.rejections, [first.json()]);
  await assert.rejects(
    inspectContentModification(
      f.integration.text,
      { requestId: f.requestId, expectedSnapshot: before.snapshot },
      f.cat,
    ),
    /proposal_changed/,
  );
  const proposalsPage = await inspectContentModification(
    f.integration.text,
    { requestId: f.requestId, view: 'proposals' },
    f.cat,
  );
  assert.deepEqual(JSON.parse(proposalsPage.json)[0].humanRejection, first.json());
  const second = await f.integration.text.respond(
    {
      ...f.response,
      operationId: randomUUID(),
      expectedProposalRevision: 1,
      edits: [{ start: 4, end: 7, expectedText: 'old', replacement: 'better' }],
    },
    f.cat,
  );
  await f.integration.results.accept(
    { ...f.command, acceptOperationId: randomUUID(), candidateRef: second.proposal.proposalRef },
    f.human,
  );
  assert.equal(await readFile(join(f.root, 'guide.md'), 'utf8'), 'The better text.');
});

test('candidate rejection is a direct-human decision bound to this request and candidate', async (t) => {
  const f = await candidateFixture(t);
  const url = `/api/content-modifications/${f.requestId}/reject`;
  for (const [headers, candidateRef, status] of [
    [{ 'x-cat-cafe-user': 'other' }, f.command.candidateRef, 404],
    [{ 'x-cat-cafe-user': 'operator', 'x-invocation-id': 'cat-session' }, f.command.candidateRef, 401],
    [{ 'x-cat-cafe-user': 'operator' }, 'unrelated-candidate', 404],
  ] as const) {
    const response = await f.app.inject({ method: 'POST', url, headers, payload: { candidateRef } });
    assert.equal(response.statusCode, status, response.body);
  }
  assert.equal(f.store.acceptances.rejections(f.requestId, 'operator').length, 0);
  assert.equal(await readFile(join(f.root, 'guide.md'), 'utf8'), 'The old text.');
});

test('an existing explicit acceptance cannot be undone by rejecting the same candidate during an unknown file effect', async (t) => {
  const f = await candidateFixture(t);
  const write = f.integration.writer.accept.bind(f.integration.writer);
  f.integration.writer.accept = async () => {
    throw new Error('before file owner commit');
  };
  await assert.rejects(f.integration.results.accept(f.command, f.human), /before file owner commit/);
  const rejected = await f.reject();
  assert.equal(rejected.statusCode, 409, rejected.body);
  assert.equal(rejected.json().error, 'acceptance_exists');
  f.integration.writer.accept = write;
  await f.integration.results.accept(f.command, f.human);
  assert.equal(await readFile(join(f.root, 'guide.md'), 'utf8'), 'The new text.');
});

test('a rejection committed while acceptance reads candidate bytes wins before any F063 effect', async (t) => {
  const f = await candidateFixture(t);
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>((r) => {
      entered = r;
    }),
    blocked = new Promise<void>((r) => {
      release = r;
    });
  const read = f.integration.text.candidate.bind(f.integration.text);
  f.integration.text.candidate = async (...args) => {
    const value = await read(...args);
    entered();
    await blocked;
    return value;
  };
  const acceptance = f.integration.results.accept(f.command, f.human);
  await ready;
  assert.equal((await f.reject()).statusCode, 200);
  release();
  await assert.rejects(acceptance, /candidate_rejected/);
  assert.equal(await readFile(join(f.root, 'guide.md'), 'utf8'), 'The old text.');
  assert.equal(f.store.acceptances.list(f.requestId, 'operator').length, 0);
});
