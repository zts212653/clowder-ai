import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectRecentWorks } from '@cat-cafe/shared/recent-works';
import { WorkCatalogue } from '../src/domains/collaborative-content/works/catalogue.js';
import { htmlCreate, htmlFixture } from './helpers/living-work-html-fixture.js';

test('Works fixed-version HTTP reads and a cat resume/edit share the same owner handle and leave v1 immutable', async (t) => {
  const f = await htmlFixture(t);
  const initial = await f.call(htmlCreate);
  assert.equal(initial.statusCode, 200, initial.body);
  const first = JSON.parse(initial.json().json).reference;
  const human = (reference: typeof first) =>
    f.app.inject({
      method: 'POST',
      url: '/api/works/command',
      headers: { 'x-fixture-user': 'operator' },
      payload: { threadId: 'thread-cover', command: { action: 'read-body', reference } },
    });
  assert.equal((await human(first)).json().html, htmlCreate.source.html);
  const published = await f.service.reference(first, f.principal);
  assert.equal(published.block.meta.mediaType, 'text/html');
  const resumed = await f.call({ action: 'read-body', reference: first });
  assert.equal(resumed.statusCode, 200, resumed.body);
  const source = JSON.parse(resumed.json().json).html;
  const second = await f.call({
    ...htmlCreate,
    action: 'submit',
    operationId: 'cat-continued-v2',
    contentRef: first.contentRef,
    expectedOwnerRevision: first.ownerRevision,
    source: { kind: 'html', html: source.replace('开始', '继续') },
  });
  assert.equal(second.statusCode, 200, second.body);
  const next = JSON.parse(second.json().json).reference;
  assert.equal(next.contentRef, first.contentRef);
  assert.equal(next.ownerRevision, 2);
  assert.equal((await human(first)).json().html, htmlCreate.source.html);
  assert.equal((await human(next)).json().html, htmlCreate.source.html.replace('开始', '继续'));
  const recent = await new WorkCatalogue(f.service).readRecent({
    ownerUserId: 'operator',
    threadTitles: new Map([['thread-cover', 'HTML work']]),
    limit: 12,
  });
  const home = projectRecentWorks(recent.artifacts, 'resolved', 12);
  assert.equal(home.length, 1, 'Home recent works must retain the saved HTML owner');
  assert.equal(home[0]?.type, 'widget');
  assert.equal(home[0]?.threadId, 'thread-cover');
  assert.deepEqual(home[0]?.work, { ...next, currentOwnerRevision: 2 });
  const forbidden = await human({ ...first, ownerRevision: 3 });
  assert.equal(forbidden.statusCode, 403, forbidden.body);
  assert.equal(forbidden.json().html, undefined);
  assert.equal((await f.owner.listOutbox(first.contentRef)).length, 2, 'preview reads never save a version');
});
