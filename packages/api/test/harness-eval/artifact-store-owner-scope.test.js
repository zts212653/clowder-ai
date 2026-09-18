import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import { loadEvalHubSummary } from '../../dist/infrastructure/harness-eval/hub/eval-hub-read-model.js';
import { createLocalArtifactPublisher } from '../../dist/infrastructure/harness-eval/publish-verdict/local-artifact-publisher.js';
import { evalHubRoutes } from '../../dist/routes/eval-hub.js';
import {
  expectedArtifactDir,
  hubReadableGenerator,
  makeHarnessLedgerDomainRegistry,
  makePacket,
  publishOpts,
} from './local-artifact-publisher-fixtures.js';

/**
 * F257 — the artifact store is partitioned by owner.
 *
 * Verdicts are generated from owner-scoped evidence. Before the partition, every
 * artifact shared one `<domain>/<id>` namespace and the Eval Hub listed the whole
 * store for any session: two owners could not publish the same id, and each could
 * read the other's verdicts and evidence.
 */
describe('artifact store owner scope', () => {
  let tmp;
  let harnessFeedbackRoot;
  let artifactStoreRoot;
  const now = new Date('2099-01-01T00:00:00.000Z');

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'artifact-owner-scope-'));
    harnessFeedbackRoot = join(tmp, 'repo', 'docs', 'harness-feedback');
    artifactStoreRoot = join(tmp, 'data', 'harness-feedback', 'artifacts');
    makeHarnessLedgerDomainRegistry(harnessFeedbackRoot);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  async function publish(owner, packet, phenomenon) {
    const publisher = createLocalArtifactPublisher({ artifactRoot: artifactStoreRoot });
    return publisher.publishArtifact(publishOpts(packet, hubReadableGenerator(packet, { phenomenon }), owner));
  }

  it('publishes the same artifact id independently for two owners', async () => {
    const packet = makePacket({ id: 'hlr-shared-id' });
    const refA = await publish('owner-a', packet, 'seen by a');
    const refB = await publish('owner-b', packet, 'seen by b');

    assert.equal(refA.artifactUrl, refB.artifactUrl, 'the public artifact identity does not carry the owner');
    assert.notEqual(refA.verdictPath, refB.verdictPath);
    assert.ok(
      refA.verdictPath.startsWith(expectedArtifactDir(artifactStoreRoot, 'owner-a', 'eval-harness-ledger', packet.id)),
    );
    assert.ok(
      refB.verdictPath.startsWith(expectedArtifactDir(artifactStoreRoot, 'owner-b', 'eval-harness-ledger', packet.id)),
    );
    assert.match(readFileSync(refA.verdictPath, 'utf8'), /Phenomenon: seen by a/);
    assert.match(readFileSync(refB.verdictPath, 'utf8'), /Phenomenon: seen by b/);
  });

  it('lists only the reading owner’s artifacts, addressed by coordinates rather than paths', async () => {
    await publish('owner-a', makePacket({ id: 'hlr-a-only' }), 'a');
    await publish('owner-b', makePacket({ id: 'hlr-b-only' }), 'b');

    const read = (ownerUserId) =>
      loadEvalHubSummary({ harnessFeedbackRoot, artifactStore: { root: artifactStoreRoot, ownerUserId }, now });

    const summaryA = read('owner-a');
    assert.deepEqual(
      summaryA.items.map((item) => item.id),
      ['hlr-a-only'],
    );
    assert.deepEqual(summaryA.items[0].source, {
      kind: 'artifact',
      domainSlug: 'eval-harness-ledger',
      artifactId: 'hlr-a-only',
      verdictId: 'hlr-a-only',
    });
    assert.equal(
      JSON.stringify(summaryA.items).includes(artifactStoreRoot),
      false,
      'no server path to the store may reach the client',
    );
    assert.deepEqual(
      read('owner-b').items.map((item) => item.id),
      ['hlr-b-only'],
    );
    assert.deepEqual(read('owner-c').items, []);
    assert.deepEqual(
      loadEvalHubSummary({ harnessFeedbackRoot, now }).items,
      [],
      'without an owner the store is not read at all',
    );
  });

  describe('GET /api/eval-hub/artifacts/:domainSlug/:artifactId/verdicts/:verdictId/files/:fileKey', () => {
    async function buildApp(sessionUserId, options = {}) {
      const app = Fastify({ logger: false });
      app.addHook('preHandler', async (request) => {
        if (sessionUserId) request.sessionUserId = sessionUserId;
      });
      await app.register(evalHubRoutes, {
        harnessFeedbackRoot,
        ...('artifactStoreRoot' in options ? options : { artifactStoreRoot }),
      });
      return app;
    }

    const url = (artifactId, fileKey, domainSlug = 'eval-harness-ledger') =>
      `/api/eval-hub/artifacts/${domainSlug}/${artifactId}/verdicts/${artifactId}/files/${fileKey}`;

    it('serves the owner’s own verdict and bundle files by key', async (t) => {
      await publish('owner-a', makePacket({ id: 'hlr-readable' }), 'readable');
      const app = await buildApp('owner-a');
      t.after(() => app.close());

      const verdict = await app.inject({ method: 'GET', url: url('hlr-readable', 'verdict') });
      assert.equal(verdict.statusCode, 200, verdict.body);
      assert.equal(verdict.json().contentType, 'text/markdown');
      assert.match(verdict.json().content, /Phenomenon: readable/);
      assert.equal(verdict.json().truncated, false);

      const snapshot = await app.inject({ method: 'GET', url: url('hlr-readable', 'snapshot') });
      assert.equal(snapshot.statusCode, 200, snapshot.body);
      assert.equal(snapshot.json().contentType, 'application/json');
      assert.equal(JSON.parse(snapshot.json().content).verdictId, 'hlr-readable');
    });

    it('answers another owner’s artifact exactly like a missing one', async (t) => {
      await publish('owner-a', makePacket({ id: 'hlr-private' }), 'private');
      const app = await buildApp('owner-b');
      t.after(() => app.close());

      const other = await app.inject({ method: 'GET', url: url('hlr-private', 'verdict') });
      const missing = await app.inject({ method: 'GET', url: url('hlr-does-not-exist', 'verdict') });
      assert.equal(other.statusCode, 404);
      assert.deepEqual(other.json(), missing.json());
    });

    it('requires a session and rejects references that are not coordinates or known keys', async (t) => {
      const anonymous = await buildApp(undefined);
      t.after(() => anonymous.close());
      assert.equal((await anonymous.inject({ method: 'GET', url: url('hlr-x', 'verdict') })).statusCode, 401);

      const app = await buildApp('owner-a');
      t.after(() => app.close());
      for (const bad of [
        url('hlr-x', 'provenance'),
        url('hlr-x', 'verdict', 'not-an-eval-domain'),
        url('.staging-hlr-x', 'verdict'),
        url('%2E%2E%2Fescape', 'verdict'),
      ]) {
        const response = await app.inject({ method: 'GET', url: bad });
        assert.equal(response.statusCode, 400, `${bad} → ${response.body}`);
      }
    });

    it('does not follow a file that links out of its artifact', async (t) => {
      const ref = await publish('owner-a', makePacket({ id: 'hlr-linked' }), 'linked');
      const secret = join(tmp, 'secret.json');
      writeFileSync(secret, '{"secret":true}');
      const snapshotPath = join(ref.bundleDir, 'snapshot.json');
      unlinkSync(snapshotPath);
      symlinkSync(secret, snapshotPath);

      const app = await buildApp('owner-a');
      t.after(() => app.close());
      assert.equal((await app.inject({ method: 'GET', url: url('hlr-linked', 'snapshot') })).statusCode, 404);
    });

    it('reports artifacts as missing when no store is configured', async (t) => {
      const app = await buildApp('owner-a', { artifactStoreRoot: undefined });
      t.after(() => app.close());
      assert.equal((await app.inject({ method: 'GET', url: url('hlr-x', 'verdict') })).statusCode, 404);
    });
  });
});
