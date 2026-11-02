import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  commitWorkSchema,
  MAX_HTML_WORK_BYTES,
  MAX_HTML_WORK_COMMAND_BYTES,
  MAX_HTML_WORK_VERSIONS,
  MAX_WORK_COMMAND_BYTES,
} from '@cat-cafe/shared';
import { WorkCatalogue } from '../src/domains/collaborative-content/works/catalogue.js';
import { LivingWorkService } from '../src/domains/collaborative-content/works/service.js';
import { ProjectContentOwnerService } from '../src/domains/video-studio/content-owner/service.js';
import { htmlCreate, htmlFixture } from './helpers/living-work-html-fixture.js';

const next = (contentRef: string, operationId = 'html-v2', html = '<p>第二版</p>') => ({
  ...htmlCreate,
  action: 'submit',
  contentRef,
  expectedOwnerRevision: 1,
  operationId,
  title: '改名了',
  source: { kind: 'html', html },
});

test('HTML uses the existing work owner, preserves source and old versions after restart, and never copies body to metadata', async (t) => {
  const f = await htmlFixture(t);
  const first = await f.service.commit(htmlCreate, f.principal);
  assert.match(first.reference.contentRef, /^work:[a-f0-9]{64}$/);
  const second = await f.service.commit(next(first.reference.contentRef), f.principal);
  assert.equal(second.reference.contentRef, first.reference.contentRef);
  assert.equal(second.reference.ownerRevision, 2);
  const restarted = new LivingWorkService({ ...f.deps, owner: new ProjectContentOwnerService({ dataDir: f.root }) });
  assert.equal((await restarted.readBody(first.reference, f.principal)).html, htmlCreate.source.html);
  assert.equal((await restarted.readBody(second.reference, f.principal)).html, '<p>第二版</p>');
  const metadata = await restarted.read(first.reference, f.principal);
  assert.equal(metadata.currentOwnerRevision, 2);
  assert.deepEqual(metadata.version.source, { kind: 'html' });
  assert.ok(!JSON.stringify(metadata).includes('document.querySelector'));
  assert.equal(metadata.description.publicationScope?.ownerUserId, 'operator');
  assert.deepEqual(metadata.revision.committedBy, f.principal.actor);
  const other = await restarted.commit({ ...htmlCreate, operationId: 'independent' }, f.principal);
  assert.notEqual(other.reference.contentRef, first.reference.contentRef, 'same title/body is not identity');
  assert.equal(f.messages.size, 0, 'saving is silent');
});

test('HTML CAS has one concurrent winner; identical replay has no effects and changed payload cannot reuse operationId', async (t) => {
  const f = await htmlFixture(t);
  const first = await f.service.commit(htmlCreate, f.principal);
  assert.deepEqual(await f.service.commit(htmlCreate, f.principal), first);
  await assert.rejects(
    f.service.commit({ ...htmlCreate, source: { kind: 'html', html: '<p>different</p>' } }, f.principal),
    /reused/i,
  );
  const outcomes = await Promise.allSettled([
    f.service.commit(next(first.reference.contentRef, 'writer-a'), f.principal),
    f.service.commit(next(first.reference.contentRef, 'writer-b', '<p>competing</p>'), f.principal),
  ]);
  assert.equal(outcomes.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(
    outcomes.filter((item) => item.status === 'rejected' && /conflict/i.test(String(item.reason))).length,
    1,
  );
  assert.equal((await f.owner.listOutbox(first.reference.contentRef)).length, 2);
  const winner = outcomes.find((item) => item.status === 'fulfilled');
  assert.ok(winner?.status === 'fulfilled');
  const command = next(
    first.reference.contentRef,
    winner.value.receipt.operationId,
    winner.value.receipt.operationId === 'writer-a' ? '<p>第二版</p>' : '<p>competing</p>',
  );
  assert.deepEqual(await f.service.commit(command, f.principal), winner.value);
  assert.equal((await f.owner.describe(first.reference.contentRef)).currentOwnerRevision, 2);
});

test('unpublished HTML is discovered by the original Works projection without executable URL or body; media picker is unchanged', async (t) => {
  const f = await htmlFixture(t);
  const first = await f.service.commit(htmlCreate, f.principal);
  const page = await new WorkCatalogue(f.service).readThread({ ownerUserId: 'operator', threadId: 'thread-cover' });
  assert.equal(page.artifacts.length, 1);
  assert.equal(page.artifacts[0]?.type, 'widget');
  assert.equal(page.artifacts[0]?.url, undefined);
  assert.equal(page.artifacts[0]?.sourceMessageId, null);
  assert.deepEqual(page.artifacts[0]?.work, { ...first.reference, currentOwnerRevision: 1 });
  assert.ok(!JSON.stringify(page).includes('<html>'));
  assert.deepEqual((await f.owner.listRetainedMedia('operator')).items, []);
  assert.deepEqual(
    (await f.media.listRetained({ userId: 'operator', actor: { kind: 'human', actorId: 'operator' } })).items,
    [],
  );
});

test('HTML input rejects oversize UTF-8, NUL, malformed Unicode and caller authority; HTML transport stays bounded', async (t) => {
  const f = await htmlFixture(t);
  for (const html of [
    '',
    ' ',
    '\0',
    '\ud800',
    'x'.repeat(MAX_HTML_WORK_BYTES + 1),
    '猫'.repeat(Math.floor(MAX_HTML_WORK_BYTES / 3) + 1),
  ]) {
    assert.equal(commitWorkSchema.safeParse({ ...htmlCreate, source: { kind: 'html', html } }).success, false);
    assert.equal((await f.call({ ...htmlCreate, source: { kind: 'html', html } })).statusCode, 400);
  }
  assert.equal((await f.call({ ...htmlCreate, actor: f.principal.actor })).statusCode, 400);
  const html = `${'猫'.repeat(Math.floor(MAX_HTML_WORK_BYTES / 3))}${'x'.repeat(MAX_HTML_WORK_BYTES % 3)}`;
  const boundary = await f.call({ ...htmlCreate, source: { kind: 'html', html } });
  assert.equal(boundary.statusCode, 200, boundary.body);
  assert.equal((await f.service.readBody(JSON.parse(boundary.json().json).reference, f.principal)).html, html);
  const tooLargeEnvelope = await f.call({
    ...htmlCreate,
    source: { kind: 'html', html: 'x'.repeat(MAX_HTML_WORK_COMMAND_BYTES + 1) },
  });
  assert.equal(tooLargeEnvelope.statusCode, 413);
  assert.equal((await f.service.list(f.principal)).items.length, 1);
});

test('non-HTML commands keep the 32 KiB transport limit on both HTTP entries', async (t) => {
  const f = await htmlFixture(t);
  const origin = await f.app.listen({ port: 0, host: '127.0.0.1' });
  for (const url of ['/api/works/command', '/api/callbacks/work']) {
    const command = { action: 'list' };
    const body = JSON.stringify({ threadId: 'thread-cover', command });
    const headers = {
      ...(url === '/api/works/command' ? { 'x-fixture-user': 'operator' } : f.headers),
      'content-type': 'application/json',
    };
    const boundary = await f.app.inject({
      method: 'POST',
      url,
      headers,
      payload: body.padEnd(MAX_WORK_COMMAND_BYTES),
    });
    assert.equal(boundary.statusCode, 200, boundary.body);
    const tooLarge = await f.app.inject({
      method: 'POST',
      url,
      headers,
      payload: body.padEnd(MAX_WORK_COMMAND_BYTES + 1),
    });
    assert.equal(tooLarge.statusCode, 413, tooLarge.body);
    for (const [bytes, expectedStatus] of [
      [MAX_WORK_COMMAND_BYTES, 200],
      [MAX_WORK_COMMAND_BYTES + 1, 413],
    ]) {
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const request = httpRequest(new URL(url, origin), { method: 'POST', headers }, (response) => {
          response.resume();
          response.on('end', () => resolve(response.statusCode));
          response.on('error', reject);
        });
        request.on('error', reject);
        request.write(body.padEnd(bytes));
        request.end();
      });
      assert.equal(status, expectedStatus, `${url}: chunked ${bytes} bytes`);
    }
  }
});

test('owner enforces the HTML version quota inside its write lock; replay at capacity still succeeds', async (t) => {
  const f = await htmlFixture(t);
  const first = await f.service.commit(htmlCreate, f.principal);
  let last = first;
  for (let revision = 2; revision <= MAX_HTML_WORK_VERSIONS; revision++) {
    last = await f.service.commit(
      {
        ...next(first.reference.contentRef, `v${revision}`, `<p>${revision}</p>`),
        expectedOwnerRevision: revision - 1,
      },
      f.principal,
    );
  }
  const finalCommand = {
    ...next(first.reference.contentRef, `v${MAX_HTML_WORK_VERSIONS}`, `<p>${MAX_HTML_WORK_VERSIONS}</p>`),
    expectedOwnerRevision: MAX_HTML_WORK_VERSIONS - 1,
  };
  assert.deepEqual(await f.service.commit(finalCommand, f.principal), last);
  const response = await f.call({
    ...next(first.reference.contentRef, 'over-limit'),
    expectedOwnerRevision: MAX_HTML_WORK_VERSIONS,
  });
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().error, 'work_version_limit');
  assert.equal((await f.owner.describe(first.reference.contentRef)).currentOwnerRevision, MAX_HTML_WORK_VERSIONS);
  assert.equal((await f.service.readBody(first.reference, f.principal)).html, htmlCreate.source.html);
});

test('owner success plus SQLite failure reports version_saved and recovers the same HTML receipt', async (t) => {
  const f = await htmlFixture(t);
  const record = f.store.works.recordVersion.bind(f.store.works);
  f.store.works.recordVersion = () => {
    throw new Error('injected annotation failure');
  };
  const failed = await f.call(htmlCreate);
  assert.equal(failed.statusCode, 503, failed.body);
  assert.equal(failed.json().status, 'version_saved');
  assert.equal(failed.json().retry, 'same_operation_and_payload');
  f.store.works.recordVersion = record;
  const recovered = await f.service.commit(htmlCreate, f.principal);
  assert.deepEqual(recovered.receipt, failed.json().receipt);
  assert.equal((await f.owner.listOutbox(recovered.reference.contentRef)).length, 1);
  assert.equal((await f.service.readBody(recovered.reference, f.principal)).html, htmlCreate.source.html);
});

test('failure at initial effect publishes no half owner or annotation and the same request can retry', async (t) => {
  const f = await htmlFixture(t);
  const authorize = f.deps.authorize;
  let checks = 0;
  const interrupted = new LivingWorkService({
    ...f.deps,
    authorize: async (input) => {
      await authorize(input);
      if (++checks === 4) throw new Error('injected effect failure');
    },
  });
  await assert.rejects(interrupted.commit(htmlCreate, f.principal), /effect failure/);
  assert.deepEqual((await f.service.list(f.principal)).items, []);
  const canonicalRoot = join(f.root, 'projects/content-owner-v1');
  assert.deepEqual(await readdir(canonicalRoot), []);
  const saved = await f.service.commit(htmlCreate, f.principal);
  assert.equal(saved.reference.ownerRevision, 1);
  const rows = f.store.works.get('operator', saved.reference.contentRef, 1);
  assert.ok(rows);
  assert.ok(!JSON.stringify(rows).includes(htmlCreate.source.html));
  const directories = await readdir(canonicalRoot);
  const directory = directories[0];
  assert.ok(directory);
  const manifest = JSON.parse(await readFile(join(canonicalRoot, directory, 'state.json'), 'utf8'));
  assert.equal(manifest.revisions.length, 1);
});

test('UTF-8 BOM is preserved as source data across fixed-version JSON readback', async (t) => {
  const f = await htmlFixture(t);
  const html = `\uFEFF${htmlCreate.source.html}`;
  const saved = await f.service.commit({ ...htmlCreate, source: { kind: 'html', html } }, f.principal);
  assert.equal((await f.service.readBody(saved.reference, f.principal)).html, html);
});
