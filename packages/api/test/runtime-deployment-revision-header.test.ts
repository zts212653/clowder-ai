import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEPLOYMENT_REVISION_HEADER, DEPLOYMENT_REVISION_UNKNOWN } from '@cat-cafe/shared';
import cors from '@fastify/cors';
import Fastify from 'fastify';
import {
  API_CORS_EXPOSED_HEADERS,
  registerDeploymentRevisionHeader,
} from '../src/domains/runtime-deployment/RuntimeDeploymentRevisionHeader.js';

const hub = { origin: 'http://localhost:3003' };

async function fixture(currentRevision: () => string | null) {
  const app = Fastify();
  await app.register(cors, {
    origin: /^http:\/\/localhost(?::\d+)?$/,
    credentials: true,
    exposedHeaders: [...API_CORS_EXPOSED_HEADERS],
  });
  registerDeploymentRevisionHeader(app, currentRevision);
  app.get('/api/threads', async () => ({ threads: [] }));
  app.get('/api/failing', async (_request, reply) => reply.code(500).send({ error: 'fixture' }));
  // A validator-matched read such as the sidebar: the browser merges these headers into its cached copy.
  app.get('/api/threads/unchanged', async (_request, reply) => reply.code(304).send());
  return app;
}

test('every API response carries the revision /api/health would publish at that moment', async () => {
  // 2026-11-05: an old page ran stale code for 21 minutes because only a 2.5s
  // health probe could reveal the new revision, and it kept timing out under load.
  let revision: string | null = 'a'.repeat(40);
  const app = await fixture(() => revision);
  try {
    const first = await app.inject({ url: '/api/threads', headers: hub });
    assert.equal(first.headers[DEPLOYMENT_REVISION_HEADER], 'a'.repeat(40));
    revision = 'b'.repeat(40); // the deployment context resolves after boot and replaces the revision
    const failing = await app.inject({ url: '/api/failing', headers: hub });
    assert.equal(failing.statusCode, 500);
    assert.equal(failing.headers[DEPLOYMENT_REVISION_HEADER], 'b'.repeat(40));
  } finally {
    await app.close();
  }
});

test('an unknown revision is published as an explicit non-revision value, never as absence', async () => {
  // Review R2 P1: a 304 only replaces the headers it carries. If unknown were published as
  // absence, revalidating a copy cached under revision A would keep A on a newer bundle and
  // latch the reload gate: exactly the "unknown is not unequal" violation F294 forbids.
  const app = await fixture(() => null);
  try {
    const response = await app.inject({ url: '/api/threads', headers: hub });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers[DEPLOYMENT_REVISION_HEADER], DEPLOYMENT_REVISION_UNKNOWN);
    assert.doesNotMatch(DEPLOYMENT_REVISION_UNKNOWN, /^[0-9a-f]{40}$/);
  } finally {
    await app.close();
  }
});

test('a 304 revalidation carries the current revision so it overwrites the cached copy', async () => {
  let revision: string | null = 'a'.repeat(40);
  const app = await fixture(() => revision);
  try {
    const known = await app.inject({ url: '/api/threads/unchanged', headers: hub });
    assert.equal(known.statusCode, 304);
    assert.equal(known.headers[DEPLOYMENT_REVISION_HEADER], 'a'.repeat(40));
    revision = null;
    const unknown = await app.inject({ url: '/api/threads/unchanged', headers: hub });
    assert.equal(unknown.statusCode, 304);
    assert.equal(unknown.headers[DEPLOYMENT_REVISION_HEADER], DEPLOYMENT_REVISION_UNKNOWN);
  } finally {
    await app.close();
  }
});

test('a cross-origin Hub page is allowed to read the revision and the existing save trace', async () => {
  const app = await fixture(() => 'a'.repeat(40));
  try {
    const response = await app.inject({ url: '/api/threads', headers: hub });
    const exposed = String(response.headers['access-control-expose-headers'] ?? '')
      .split(',')
      .map((name) => name.trim().toLowerCase());
    assert.ok(exposed.includes(DEPLOYMENT_REVISION_HEADER), exposed.join(','));
    assert.ok(exposed.includes('x-clowder-save-id'), exposed.join(','));
  } finally {
    await app.close();
  }
});
