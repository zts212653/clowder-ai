import assert from 'node:assert/strict';
import { test } from 'node:test';
import { candidateKey, contentRevision } from '../../dist/domains/memory/message-query-protocol.js';
import { MessageQueryQualifier } from '../../dist/domains/memory/message-query-qualifier.js';

const row = (id, content) => ({
  threadId: 'readable',
  messageId: id,
  content,
  contentRevision: contentRevision(content),
});
const context = () => ({ userId: 'owner', resultLimit: 3, deadlineAt: Date.now() + 5000 });

test('a limit-three page judges at most four whole bodies in two bounded calls', async () => {
  const batches = [];
  const qualifier = new MessageQueryQualifier(async (batch) => {
    batches.push(batch);
    return JSON.stringify({ requestId: batch.requestId, rows: batch.rows.map((r) => [r.id, 'indeterminate', null]) });
  });
  const candidates = Array.from({ length: 20 }, (_, i) =>
    row(String(i), 'Neri naming comparison ' + 'x'.repeat(i * 100)),
  );
  const before = structuredClone(candidates);
  const result = await qualifier.qualify('Neri naming', candidates, context());
  assert.equal(batches.length, 2);
  assert.equal(batches.flatMap((batch) => batch.rows).length, 4);
  assert.deepEqual(
    batches
      .flatMap((batch) => batch.rows)
      .map((r) => r.messageId)
      .sort(),
    ['0', '1', '2', '3'],
  );
  assert.equal(result.meta.examined, 20);
  assert.equal(result.meta.indeterminate, 4);
  assert.equal(result.meta.unassessed, 16);
  assert.equal(result.meta.status, 'partial');
  assert.deepEqual(candidates, before);
});

test('same-word neighbours cannot starve a zero-clue semantic-only body out of the small page', async () => {
  const positive = row('semantic-only', 'The portable computer got a fresh power pack.');
  const neighbours = Array.from({ length: 12 }, (_, i) =>
    row('neighbour-' + i, 'Laptop battery replacement advice for a handset, not the portable computer.'),
  );
  const all = [...neighbours, positive];
  const calls = [];
  const qualifier = new MessageQueryQualifier(async (batch) => {
    calls.push(batch);
    return JSON.stringify({
      requestId: batch.requestId,
      rows: batch.rows.map((r) => [
        r.id,
        r.messageId === positive.messageId ? 'supported' : 'rejected',
        r.messageId === positive.messageId ? r.body : null,
      ]),
    });
  });
  const result = await qualifier.qualify('laptop battery replacement', all, context());
  assert.equal(result.decisions.get(candidateKey(positive)), 'supported');
  assert.equal(calls.flatMap((batch) => batch.rows).length, 4);
  assert.equal(result.meta.supported, 1);
  assert.equal(result.meta.rejected, 3);
  assert.equal(result.meta.unassessed, 9);
  assert.equal(result.evidence.get(candidateKey(positive)), positive.content);
  assert.equal(all.length, 13);
});

test('the semantic exploration opportunity also reserves whole-body character capacity', async () => {
  const positive = row('long-semantic', `${'Chronology. '.repeat(5000)}The notebook received a new power pack.`);
  const neighbours = Array.from({ length: 6 }, (_, i) =>
    row(`long-neighbour-${i}`, `Laptop battery replacement for a handset. ${'x'.repeat(2000)}`),
  );
  const submitted = [];
  const qualifier = new MessageQueryQualifier(async (batch) => {
    submitted.push(...batch.rows);
    return JSON.stringify({ requestId: batch.requestId, rows: batch.rows.map((r) => [r.id, 'indeterminate', null]) });
  });
  const result = await qualifier.qualify('laptop battery replacement', [...neighbours, positive], context());
  const complete = submitted.find((r) => r.messageId === positive.messageId);
  assert.ok(complete, 'The whole semantic-only source must reach qualification');
  assert.equal(contentRevision(complete.body), positive.contentRevision);
  assert.ok(submitted.reduce((sum, r) => sum + r.body.length, 0) <= 64000);
  assert.ok(submitted.length <= 4);
  assert.equal(result.meta.rejected, 0);
  assert.equal(result.meta.examined, 7);
});
