import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import { configRoutes } from '../../src/routes/config.js';

describe('owner-private ignored items (F322)', () => {
  const owner = 'ignored-items-owner';
  const headers = { 'x-cat-cafe-user': owner };
  const url = '/api/config/ignored-items';
  const schedule = { kind: 'schedule', subjectRef: 'task:work-one' };
  const request = { kind: 'mailbox', decisionRef: 'mention:thread-one', version: 'message:first:7' };
  let app: FastifyInstance;
  let projectRoot: string;
  const preferencesPath = () => join(projectRoot, '.cat-cafe', 'user-preferences.json');

  async function setup() {
    app = Fastify();
    await app.register(configRoutes, { projectRoot });
    await app.ready();
  }
  const read = (identity = headers) => app.inject({ method: 'GET', url, headers: identity });
  const patch = (expectedRevision: number, ignore: unknown[] = [], restore: unknown[] = [], identity = headers) =>
    app.inject({
      method: 'PATCH',
      url,
      headers: identity,
      payload: { expectedOwnerUserId: identity['x-cat-cafe-user'], expectedRevision, ignore, restore },
    });

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'ignored-items-preference-'));
    process.env.DEFAULT_OWNER_USER_ID = owner;
    await setup();
  });
  afterEach(async () => {
    await app.close();
    delete process.env.DEFAULT_OWNER_USER_ID;
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('persists only the personal view across recreation and preserves unrelated preferences', async () => {
    await mkdir(join(projectRoot, '.cat-cafe'));
    await writeFile(preferencesPath(), JSON.stringify({ catOrder: ['codex61-sol'], futurePreference: { keep: true } }));
    const initial = await read();
    assert.equal(initial.statusCode, 200, initial.payload);
    assert.deepEqual(initial.json(), { ownerUserId: owner, revision: 0, entries: [] });
    const saved = await patch(0, [schedule, request]);
    assert.equal(saved.statusCode, 200, saved.payload);
    assert.equal(saved.json().revision, 1);
    assert.deepEqual(
      saved.json().entries.map((entry: { coordinate: unknown }) => entry.coordinate),
      [schedule, request],
    );
    assert.ok(saved.json().entries.every((entry: { ignoredAt: number }) => Number.isFinite(entry.ignoredAt)));
    await app.close();
    await setup();
    assert.deepEqual((await read()).json(), saved.json());
    const persisted = JSON.parse(await readFile(preferencesPath(), 'utf8'));
    assert.deepEqual(persisted.catOrder, ['codex61-sol']);
    assert.deepEqual(persisted.futurePreference, { keep: true });
    assert.equal(persisted.ignoredItems.owners[owner].revision, 1);
    assert.equal('expiresAt' in persisted.ignoredItems.owners[owner], false);
  });

  it('fences concurrent tabs without losing prior ignores and restores the exact old version', async () => {
    const newerRequest = { ...request, version: 'message:second:8' };
    const first = await patch(0, [request]);
    assert.equal(first.statusCode, 200, first.payload);
    const stale = await patch(0, [schedule]);
    assert.equal(stale.statusCode, 409, stale.payload);
    assert.deepEqual(stale.json().snapshot, first.json());
    const merged = await patch(1, [schedule, newerRequest]);
    assert.equal(merged.statusCode, 200, merged.payload);
    const restored = await patch(2, [], [request]);
    assert.equal(restored.statusCode, 200, restored.payload);
    assert.deepEqual(
      restored.json().entries.map((entry: { coordinate: unknown }) => entry.coordinate),
      [schedule, newerRequest],
    );
    assert.equal((await patch(3, [schedule])).json().revision, 3, 'idempotent ignore must not create a revision');
  });

  it('requires authenticated owner identity and isolates two admitted owners', async () => {
    assert.equal((await read({})).statusCode, 401);
    assert.equal((await patch(0, [schedule], [], { 'x-cat-cafe-user': 'guest' })).statusCode, 403);
    assert.equal((await patch(0, [schedule])).statusCode, 200);
    delete process.env.DEFAULT_OWNER_USER_ID;
    const secondHeaders = { 'x-cat-cafe-user': 'second-owner' };
    assert.deepEqual((await read(secondHeaders)).json(), { ownerUserId: 'second-owner', revision: 0, entries: [] });
    assert.equal((await patch(0, [request], [], secondHeaders)).statusCode, 200);
    assert.deepEqual(
      (await read()).json().entries.map((entry: { coordinate: unknown }) => entry.coordinate),
      [schedule],
    );
  });

  it('refuses an actor-unspecific saved-page change after the authenticated owner changed', async () => {
    const oldRead = (await read()).json();
    delete process.env.DEFAULT_OWNER_USER_ID;
    const changedOwner = { 'x-cat-cafe-user': 'second-owner' };
    const response = await app.inject({
      method: 'PATCH',
      url,
      headers: changedOwner,
      payload: { expectedRevision: oldRead.revision, ignore: [schedule], restore: [] },
    });
    assert.equal(response.statusCode, 400, response.payload);
    assert.deepEqual((await read(changedOwner)).json().entries, []);
  });

  it('checks the intended actor against the session instead of treating it as owner selection', async () => {
    delete process.env.DEFAULT_OWNER_USER_ID;
    const changedOwner = { 'x-cat-cafe-user': 'second-owner' };
    const response = await app.inject({
      method: 'PATCH',
      url,
      headers: changedOwner,
      payload: { expectedOwnerUserId: owner, expectedRevision: 0, ignore: [schedule], restore: [] },
    });
    assert.equal(response.statusCode, 409, response.payload);
    assert.deepEqual((await read()).json().entries, []);
    assert.deepEqual((await read(changedOwner)).json().entries, []);
  });

  it('rejects malformed or ambiguous coordinates instead of silently broadening an ignore', async () => {
    for (const coordinate of [
      { kind: 'schedule', subjectRef: '' },
      { kind: 'mailbox', decisionRef: request.decisionRef },
      { kind: 'mailbox', decisionRef: request.decisionRef, version: '' },
      { ...schedule, ownerUserId: 'guest' },
    ])
      assert.equal((await patch(0, [coordinate])).statusCode, 400);
    assert.equal((await patch(0, [schedule], [schedule])).statusCode, 400);
    assert.equal((await patch(-1, [schedule])).statusCode, 400);
    assert.deepEqual((await read()).json().entries, []);
  });

  it('does not pretend a corrupt preference file is empty or replace it on save', async () => {
    await mkdir(join(projectRoot, '.cat-cafe'));
    const corrupt = '{ "catOrder": ["codex61-sol"],';
    await writeFile(preferencesPath(), corrupt);
    assert.equal((await read()).statusCode, 503);
    assert.equal((await patch(0, [schedule])).statusCode, 503);
    assert.equal(await readFile(preferencesPath(), 'utf8'), corrupt);
  });

  it('retains other owner and future lane metadata when saving and reports write failures', async () => {
    await mkdir(join(projectRoot, '.cat-cafe'));
    await writeFile(
      preferencesPath(),
      JSON.stringify({ ignoredItems: { futureMode: 'preserve', owners: { other: { revision: 12, entries: [] } } } }),
    );
    assert.equal((await patch(0, [schedule])).statusCode, 200);
    const persisted = JSON.parse(await readFile(preferencesPath(), 'utf8'));
    assert.equal(persisted.ignoredItems.futureMode, 'preserve');
    assert.deepEqual(persisted.ignoredItems.owners.other, { revision: 12, entries: [] });
    await rm(join(projectRoot, '.cat-cafe'), { recursive: true });
    await writeFile(join(projectRoot, '.cat-cafe'), 'blocked preference directory');
    assert.equal((await patch(0, [request])).statusCode, 503);
  });
});
