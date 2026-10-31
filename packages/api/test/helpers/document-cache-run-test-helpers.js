/**
 * F279 server-owned full-document cache runs — shared test harness.
 *
 * Split from monolithic document-cache-runs.test.js to honor the 350-line
 * hard cap while keeping repository / Fastify boilerplate in one place.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { DocumentListenRepository } from '../../dist/domains/cats/services/tts/DocumentListenRepository.js';
import { TtsRegistry } from '../../dist/domains/cats/services/tts/TtsRegistry.js';
import { ttsRoutes } from '../../dist/routes/tts.js';

export function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export async function waitFor(assertion, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}

export function headers(userId) {
  return { 'x-cat-cafe-user': userId, 'content-type': 'application/json' };
}

export function documentState(identity, anchors) {
  return {
    identity,
    sentences: anchors.map((anchor) => ({ anchor })),
    position: { anchor: anchors[0] ?? null, offsetSeconds: 0 },
    playbackRate: 1,
    retention: '7d',
    updatedAt: 100,
  };
}

export async function createHarness(stream) {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'document-cache-runs-'));
  const repository = new DocumentListenRepository(path.join(tempDir, 'listen-mode.sqlite'));
  await repository.initialize();
  const registry = new TtsRegistry();
  registry.register({
    id: 'test-tts',
    model: 'test-model',
    synthesize: async () => ({ audio: Buffer.from('unused'), format: 'wav', durationSec: 1 }),
    stream,
  });
  const app = Fastify({ logger: false });
  await app.register(ttsRoutes, { ttsRegistry: registry, cacheDir: tempDir, documentListenRepository: repository });
  return { app, registry, repository, tempDir };
}

export async function closeHarness(harness) {
  if (!harness.appClosed) await harness.app.close();
  harness.repository.close();
  await rm(harness.tempDir, { recursive: true, force: true });
}

export async function saveDocument(app, userId, identity, anchors, synthesis) {
  const response = await app.inject({
    method: 'PUT',
    url: '/api/tts/listen/document',
    headers: headers(userId),
    payload: { ...documentState(identity, anchors), ...(synthesis ? { synthesis } : {}) },
  });
  if (response.statusCode !== 200) throw new Error(response.body);
}

export async function loadDocument(app, userId, identity) {
  const response = await app.inject({
    method: 'GET',
    url: `/api/tts/listen/document?projectPath=${encodeURIComponent(identity.projectPath)}&relativePath=${encodeURIComponent(identity.relativePath)}`,
    headers: headers(userId),
  });
  if (response.statusCode !== 200) throw new Error(response.body);
  return response.json();
}
